// `--quota`: prints a per-slot quota table. Read-only, it never switches.
//   --quota          from the running watcher's status.json (free, but idle slots may be stale or unprobed)
//   --quota --fresh  probes every slot now via `claude -p` (~$0.0007 per slot)
const fs = require('fs');
const { probeToken } = require('./setup-token-quota-probe');
const { listSetupTokenSlots } = require('./cswap-account-store');

const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);

function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const resetIn = (epochS) => (epochS ? `in ${duration(epochS * 1000 - Date.now())}` : '-');

function statusLabel(d, threshold) {
  if (!d) return 'unprobed';
  if (d.transient) return 'probe error';
  if (d.invalid) return 'INVALID';
  if (d.exhausted) return 'EXHAUSTED';
  if (d.utilPeak != null && d.utilPeak >= threshold) return `OVER ${Math.round(threshold * 100)}%`;
  return d.quotaStatus || String(d.httpStatus ?? '-');
}

function printTable(active, rows, threshold) {
  const header = ['SLOT', '', 'STATUS', '5H', 'RESETS', '7D', 'RESETS', 'AS OF'];
  const lines = rows.map(({ num, d }) => [
    String(num), num === active ? '*' : '', statusLabel(d, threshold),
    pct(d?.util5h), resetIn(d?.reset5h), pct(d?.util7d), resetIn(d?.reset7d),
    d?.at ? `${duration(Date.now() - Date.parse(d.at))} ago` : '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  for (const l of [header, ...lines]) console.log(l.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
}

async function quotaReport({ fresh, statusFile, threshold }) {
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
    console.log(`Fresh probe of ${rows.length} slot(s) · switch threshold ${Math.round(threshold * 100)}% · * = active`);
    return printTable(active, rows, threshold);
  }

  let status;
  try {
    status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch {
    return console.log('No status.json yet: is the watcher running? Use --quota --fresh to probe now.');
  }
  const next = status.nextProbeAt ? `next probe in ${duration(Date.parse(status.nextProbeAt) - Date.now())}` : '';
  console.log(`Watcher: ${status.state} · ${next} · switch threshold ${Math.round(status.threshold * 100)}% · * = active`);
  printTable(status.active, status.slots.map((s) => ({ num: s.num, d: s.detail })), status.threshold);
  if (status.slots.some((s) => !s.detail || s.num !== status.active)) {
    console.log('Idle slots are only probed right before a switch; use --quota --fresh for current numbers.');
  }
}

module.exports = { quotaReport };
