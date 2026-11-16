// Auto-swap between claude-swap setup-token slots (long-lived `claude setup-token` tokens).
// cswap's own `auto` can't see quota of setup-tokens (usage endpoint 403s them), so this
// watcher reads quota from `claude -p` rate_limit_event (official binary, no direct API calls) and calls `cswap switch` when the
// active token nears/hits its limit. Claude Code (incl. running Paseo agents) re-reads
// ~/.claude/.credentials.json on change, so the next request uses the new token — no restart.
const fs = require('fs');
const path = require('path');
const { probeToken } = require('./setup-token-quota-probe');
const { listSetupTokenSlots, switchTo, ROSTER_FILE } = require('./cswap-account-store');
const { waitForRosterChangeOrTimeout } = require('./roster-change-wait');
const { THRESHOLD_5H, THRESHOLD_WEEKLY, load, isSpent, binding, shortName } = require('./quota-policy');

// Adaptive cadence (mirrors claude-swap's poll_policy, but sparser since each probe is a real
// Claude Code turn): slow while the active token has headroom, faster as it nears its switch line
// or burns quickly. Only the active slot is probed on a schedule. "Load" is the binding window's
// utilization relative to its own line (see quota-policy.js): 1.0 = at the line.
const SLOW_MS = Number(process.env.AUTOSWAP_SLOW_S || 900) * 1000; // load < MID_AT
const MID_MS = Number(process.env.AUTOSWAP_MID_S || 300) * 1000; // MID_AT <= load < FAST_AT
const FAST_MS = Number(process.env.AUTOSWAP_FAST_S || 120) * 1000; // load >= FAST_AT, rising fast, or blocked
const BLOCKED_MS = 600 * 1000; // every token dead: wait for a reset (or sooner, see untilSoonestReset)
const MIN_TICK_GAP_MS = 30 * 1000; // roster-change wakeups never probe more often than this
const ERROR_MS = 300 * 1000; // probe failed (network, CLI): retry sooner than SLOW
const MID_AT = 0.78; // ~70% of a 90% line
const FAST_AT = 0.94; // ~85% of a 90% line
const FAST_RISE = 0.05; // load grew >= 5 points since the previous probe -> heavy use
const JITTER = 0.1; // +-10% so probes don't land on a fixed grid
const COOLDOWN_MS = Number(process.env.AUTOSWAP_COOLDOWN_S || 120) * 1000;
const STATUS_FILE = path.join(__dirname, 'status.json');
const LOG_FILE = path.join(__dirname, 'autoswap.log');
const PID_FILE = path.join(__dirname, 'watcher.pid');

const readings = new Map(); // slot num -> { at, ...probe result }
let lastSwitchAt = 0;
let lastLoggedState = null;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  fs.appendFile(LOG_FILE, line + '\n', () => {});
}


async function probe(slot) {
  const prev = readings.get(slot.num);
  try {
    const r = await probeToken(slot.token);
    const rise = prev && !prev.transient ? load(r) - load(prev) : 0;
    readings.set(slot.num, { at: Date.now(), ...r, rise });
  } catch (e) {
    readings.set(slot.num, { at: Date.now(), error: e.message, transient: true });
  }
  return readings.get(slot.num);
}

function describe(r) {
  if (!r) return 'unprobed';
  if (r.transient) return `error(${r.error})`;
  const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);
  const b = binding(r);
  const lineInfo = b.name ? ` load=${pct(b.load)}(${shortName(b.name)})` : '';
  return `${r.quotaStatus || r.httpStatus} 5h=${pct(r.util5h)} 7d=${pct(r.util7d)}${lineInfo}${r.invalid ? ' INVALID' : ''}`;
}

// Delay until the next probe of the active slot, from its latest reading
function cadenceFor(r) {
  let ms;
  if (!r || r.transient) ms = ERROR_MS;
  else if (load(r) >= FAST_AT || r.rise >= FAST_RISE) ms = FAST_MS;
  else if (load(r) >= MID_AT) ms = MID_MS;
  else ms = SLOW_MS;
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * JITTER));
}

// Returns the delay (ms) before the next tick
async function tick() {
  const { active, slots } = listSetupTokenSlots();
  if (!slots.length) return writeStatus(active, slots, 'no setup-token slots (cswap add-token ...)', SLOW_MS);

  // Probe only the active slot; idle slots are probed just-in-time when a switch is needed
  const current = slots.find((s) => s.num === active);
  if (current) await probe(current);

  const currentReading = current && readings.get(current.num);
  const hardFail = currentReading && (currentReading.exhausted || currentReading.invalid);
  const needSwitch = !current /* active slot is a login slot -> move onto the token pool */
    || (currentReading && !currentReading.transient && isSpent(currentReading));
  if (!needSwitch) return writeStatus(active, slots, 'ok', cadenceFor(currentReading));
  if (current && !hardFail && Date.now() - lastSwitchAt < COOLDOWN_MS) {
    return writeStatus(active, slots, 'cooldown', Math.max(FAST_MS, COOLDOWN_MS - (Date.now() - lastSwitchAt)));
  }

  // Re-probe candidates right before choosing so the decision uses fresh numbers
  const byRoom = (a, b) => load(a.r) - load(b.r);
  const probed = [];
  for (const s of slots) {
    if (s.num === active) continue;
    probed.push({ s, r: await probe(s) });
  }
  const candidates = probed.filter(({ r }) => !r.transient && !isSpent(r)).sort(byRoom);
  if (candidates.length) return switchAndReport(active, currentReading, candidates[0], slots, 'switched');

  // Every other slot is at/over the threshold too. While the active token still serves, stay on it
  // (moving between near-full tokens only burns probes). Once it stops serving (rejected/429/invalid),
  // escape to the slot with the most room left that still answers, even if it is over the threshold.
  if (current && hardFail) {
    const escape = probed.filter(({ r }) => !r.transient && !r.exhausted && !r.invalid).sort(byRoom)[0];
    if (escape) return switchAndReport(active, currentReading, escape, slots, 'escaped: all tokens over threshold');
  }
  // Blocked but the active token still serves: it is close to dying, so check again soon to escape quickly.
  // Every token dead: wake right after the soonest window resets (at most BLOCKED_MS).
  const blockedMs = current && !hardFail ? FAST_MS : Math.min(BLOCKED_MS, untilSoonestReset(slots));
  return writeStatus(active, slots, current ? 'blocked: all tokens spent' : 'blocked: no healthy token to move onto', blockedMs);
}

// ms until the soonest known window reset across all slots, plus a small margin; BLOCKED_MS if unknown
function untilSoonestReset(slots) {
  let soonest = Infinity;
  for (const s of slots) {
    const r = readings.get(s.num);
    if (!r || r.transient) continue;
    const resets = [r.reset5h, r.reset7d, ...Object.values(r.windows || {}).map((w) => w?.resetsAt)];
    for (const t of resets) if (t && t * 1000 > Date.now()) soonest = Math.min(soonest, t * 1000);
  }
  return Number.isFinite(soonest) ? Math.max(MIN_TICK_GAP_MS, soonest - Date.now() + 30 * 1000) : BLOCKED_MS;
}

async function switchAndReport(active, currentReading, target, slots, state) {
  log(`switch ${active} [${describe(currentReading)}] -> ${target.s.num} [${describe(target.r)}]`);
  await switchTo(target.s.num);
  lastSwitchAt = Date.now();
  // The target was just probed, so its reading drives the next cadence
  return writeStatus(target.s.num, slots, state, cadenceFor(target.r));
}

// Machine-readable copy of a reading for status.json (used by `--quota`)
function readingDetail(r) {
  if (!r) return null;
  const { at, quotaStatus, httpStatus, util5h, util7d, utilPeak, reset5h, reset7d, invalid, exhausted, transient, error } = r;
  return { at: new Date(at).toISOString(), quotaStatus, httpStatus, util5h, util7d, utilPeak, reset5h, reset7d, invalid, exhausted, transient, error, windows: r.windows, load: transient ? null : load(r) };
}

function writeStatus(active, slots, state, nextMs) {
  const status = {
    updatedAt: new Date().toISOString(),
    state,
    active,
    threshold: THRESHOLD_5H,
    weeklyThreshold: THRESHOLD_WEEKLY,
    nextProbeAt: new Date(Date.now() + nextMs).toISOString(),
    slots: slots.map((s) => ({
      num: s.num, email: s.email, reading: describe(readings.get(s.num)), detail: readingDetail(readings.get(s.num)),
    })),
  };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  // Log only state transitions so an idle/blocked watcher doesn't flood the log every tick
  if (state !== lastLoggedState && state !== 'cooldown') log(`state: ${state}`);
  lastLoggedState = state;
  return nextMs;
}

// Single instance: a live PID in watcher.pid means another watcher is running (watchdog re-launch)
function acquireSingleInstance() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    if (pid && pid !== process.pid) { process.kill(pid, 0); return false; }
  } catch { /* no pid file or dead process */ }
  fs.writeFileSync(PID_FILE, String(process.pid));
  return true;
}

async function main() {
  if (process.argv.includes('--quota')) {
    return require('./quota-report').quotaReport({ fresh: process.argv.includes('--fresh'), statusFile: STATUS_FILE });
  }
  if (process.argv.includes('--once')) return tick();
  if (!acquireSingleInstance()) return;
  log(`watcher started (cadence ${SLOW_MS / 1000}/${MID_MS / 1000}/${FAST_MS / 1000}s, lines 5h ${THRESHOLD_5H * 100}% / weekly ${THRESHOLD_WEEKLY * 100}%)`);
  for (;;) {
    const tickedAt = Date.now();
    const delay = await tick().catch((e) => { log(`tick error: ${e.message}`); return ERROR_MS; });
    // Wake early when cswap's roster changes (token added/removed, manual switch), but never tick more
    // often than MIN_TICK_GAP_MS even if something keeps rewriting the file
    const woke = await waitForRosterChangeOrTimeout(ROSTER_FILE, delay);
    if (woke === 'roster-changed') {
      log('cswap roster changed (slot added/removed or manual switch): re-checking now');
      const gap = MIN_TICK_GAP_MS - (Date.now() - tickedAt);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
  }
}

module.exports = { cadenceFor, tick, untilSoonestReset };
if (require.main === module) main();
