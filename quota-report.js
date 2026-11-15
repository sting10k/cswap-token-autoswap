// `--quota`: prints a per-slot quota table. Read-only, it never switches.
//   --quota          from the running watcher's status.json (free, but idle slots may be stale or unprobed)
//   --quota --fresh  probes every slot now via `claude -p` (~$0.0007 per slot)
const fs = require('fs');
const { probeToken } = require('./setup-token-quota-probe');
const { listSetupTokenSlots } = require('./cswap-account-store');
const { THRESHOLD_5H, THRESHOLD_WEEKLY, isSpent, overLabel } = require('./quota-policy');

const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);

function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const resetIn = (epochS) => (epochS ? `in ${duration(epochS * 1000 - Date.now())}` : '-');

function statusLabel(d) {
  if (!d) return 'unprobed';
  if (d.transient) return 'probe error';
  if (d.invalid) return 'INVALID';
  if (d.exhausted) return 'EXHAUSTED';
  if (isSpent(d)) return overLabel(d);
  return d.quotaStatus || String(d.httpStatus ?? '-');
}

const linesNote = () => `switch lines 5h ${Math.round(THRESHOLD_5H * 100)}% / weekly ${Math.round(THRESHOLD_WEEKLY * 100)}%`;

function printTable(active, rows) {
  const header = ['SLOT', '', 'STATUS', '5H', 'RESETS', '7D', 'RESETS', 'AS OF'];
  const lines = rows.map(({ num, d }) => [
    String(num), num === active ? '*' : '', statusLabel(d),
    pct(d?.util5h), resetIn(d?.reset5h), pct(d?.util7d), resetIn(d?.reset7d),
    d?.at ? `${duration(Date.now() - Date.parse(d.at))} ago` : '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  for (const l of [header, ...lines]) console.log(l.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
}

async function quotaReport({ fresh, statusFile }) {
  if (fresh) {
    const { active, slots } = listSetupTokenSlots();
    if (!slots.length) return console.log('No setup-token slots (cswap add-token ...)');
    const rows = [];
    for (const s of slots) {
      let d;
      try {
        d = { at: new Date().toISOString(), ...(await probeToken(s.token)) };
      } catch (e) {
        d = { at: new Date().toISOString(), transient: true, error: e.message };
      }
      rows.push({ num: s.num, d });
    }
    console.log(`Fresh probe of ${rows.length} slot(s) · ${linesNote()} · * = active`);
    return printTable(active, rows);
  }

  let status;
  try {
    status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch {
    return console.log('No status.json yet: is the watcher running? Use --quota --fresh to probe now.');
  }
  const next = status.nextProbeAt ? `next probe in ${duration(Date.parse(status.nextProbeAt) - Date.now())}` : '';
  console.log(`Watcher: ${status.state} · ${next} · ${linesNote()} · * = active`);
  printTable(status.active, status.slots.map((s) => ({ num: s.num, d: s.detail })));
  if (status.slots.some((s) => !s.detail || s.num !== status.active)) {
    console.log('Idle slots are only probed right before a switch; use --quota --fresh for current numbers.');
  }
}

module.exports = { quotaReport };
