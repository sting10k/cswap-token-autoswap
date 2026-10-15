// Auto-swap between claude-swap setup-token slots (long-lived `claude setup-token` tokens).
// cswap's own `auto` can't see quota of setup-tokens (usage endpoint 403s them), so this
// watcher reads quota from `claude -p` rate_limit_event (official binary, no direct API calls) and calls `cswap switch` when the
// active token nears/hits its limit. Claude Code (incl. running Paseo agents) re-reads
// ~/.claude/.credentials.json on change, so the next request uses the new token — no restart.
const fs = require('fs');
const path = require('path');
const { probeToken } = require('./setup-token-quota-probe');
const { listSetupTokenSlots, switchTo } = require('./cswap-account-store');

// Adaptive cadence (mirrors claude-swap's poll_policy, but sparser since each probe is a real
// Claude Code turn): slow while the active token has headroom, faster as it nears the threshold
// or burns quickly. Only the active slot is probed on a schedule.
const SLOW_MS = Number(process.env.AUTOSWAP_SLOW_S || 900) * 1000; // peak < MID_AT
const MID_MS = Number(process.env.AUTOSWAP_MID_S || 300) * 1000; // MID_AT <= peak < FAST_AT
const FAST_MS = Number(process.env.AUTOSWAP_FAST_S || 120) * 1000; // peak >= FAST_AT, or rising fast
const BLOCKED_MS = 600 * 1000; // all tokens spent: wait for a reset
const ERROR_MS = 300 * 1000; // probe failed (network, CLI): retry sooner than SLOW
const MID_AT = 0.7;
const FAST_AT = 0.85;
const FAST_RISE = 0.05; // peak grew >= 5 points since the previous probe -> heavy use
const JITTER = 0.1; // +-10% so probes don't land on a fixed grid
const THRESHOLD = Number(process.env.AUTOSWAP_THRESHOLD || 0.9);
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

const peakUtil = (r) => r.utilPeak ?? Math.max(r.util5h ?? 0, r.util7d ?? 0);
const isSpent = (r) => r.exhausted || r.invalid || peakUtil(r) >= THRESHOLD;

async function probe(slot) {
  const prev = readings.get(slot.num);
  try {
    const r = await probeToken(slot.token);
    const rise = prev && !prev.transient && r.utilPeak != null ? r.utilPeak - peakUtil(prev) : 0;
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
  return `${r.quotaStatus || r.httpStatus} 5h=${pct(r.util5h)} 7d=${pct(r.util7d)} peak=${pct(r.utilPeak)}${r.invalid ? ' INVALID' : ''}`;
}

// Delay until the next probe of the active slot, from its latest reading
function cadenceFor(r) {
  let ms;
  if (!r || r.transient) ms = ERROR_MS;
  else if (peakUtil(r) >= FAST_AT || r.rise >= FAST_RISE) ms = FAST_MS;
  else if (peakUtil(r) >= MID_AT) ms = MID_MS;
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
  const candidates = [];
  for (const s of slots) {
    if (s.num === active) continue;
    const r = await probe(s);
    if (!r.transient && !isSpent(r)) candidates.push({ s, r });
  }
  candidates.sort((a, b) => peakUtil(a.r) - peakUtil(b.r));
  if (!candidates.length) {
    return writeStatus(active, slots, current ? 'blocked: all tokens spent' : 'blocked: no healthy token to move onto', BLOCKED_MS);
  }

  const target = candidates[0];
  log(`switch ${active} [${describe(currentReading)}] -> ${target.s.num} [${describe(target.r)}]`);
  await switchTo(target.s.num);
  lastSwitchAt = Date.now();
  // The target was just probed, so its reading drives the next cadence
  return writeStatus(target.s.num, slots, 'switched', cadenceFor(target.r));
}

function writeStatus(active, slots, state, nextMs) {
  const status = {
    updatedAt: new Date().toISOString(),
    state,
    active,
    threshold: THRESHOLD,
    nextProbeAt: new Date(Date.now() + nextMs).toISOString(),
    slots: slots.map((s) => ({ num: s.num, email: s.email, reading: describe(readings.get(s.num)) })),
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
  if (process.argv.includes('--once')) return tick();
  if (!acquireSingleInstance()) return;
  log(`watcher started (cadence ${SLOW_MS / 1000}/${MID_MS / 1000}/${FAST_MS / 1000}s, threshold ${THRESHOLD * 100}%)`);
  for (;;) {
    const delay = await tick().catch((e) => { log(`tick error: ${e.message}`); return ERROR_MS; });
    await new Promise((r) => setTimeout(r, delay));
  }
}

module.exports = { cadenceFor };
if (require.main === module) main();
