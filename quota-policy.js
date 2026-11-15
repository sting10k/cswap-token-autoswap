// Switch lines per quota window. The 5-hour window and the weekly windows (7d and per-model weekly) each get
// their own threshold, because the last 10% of a week's budget is far more work than the last 10% of a 5-hour
// window. One shared line made a slot at "5h 0% / 7d 90%" look as full as one at "5h 90%", so the watcher sat
// on a dying token instead of moving to a slot that still had plenty of room.
const THRESHOLD_5H = Number(process.env.AUTOSWAP_THRESHOLD || 0.9);
const THRESHOLD_WEEKLY = Number(process.env.AUTOSWAP_WEEKLY_THRESHOLD || 0.98);

const lineFor = (name) => (name === 'five_hour' ? THRESHOLD_5H : THRESHOLD_WEEKLY);

// Utilization per window name (rate_limit_event `unifiedWindows` keys: five_hour, seven_day, seven_day_<model>...).
// Readings without the raw map fall back to util5h/util7d.
function windowsOf(r) {
  if (r.windows && Object.keys(r.windows).length) {
    return Object.fromEntries(Object.entries(r.windows)
      .filter(([, w]) => typeof w?.utilization === 'number')
      .map(([name, w]) => [name, w.utilization]));
  }
  const w = {};
  if (r.util5h != null) w.five_hour = r.util5h;
  if (r.util7d != null) w.seven_day = r.util7d;
  return w;
}

// The window closest to its own line, and how close: load 1.0 = exactly at the line
function binding(r) {
  let best = { name: null, load: 0 };
  for (const [name, util] of Object.entries(windowsOf(r))) {
    const load = util / lineFor(name);
    if (load > best.load) best = { name, load };
  }
  return best;
}

const load = (r) => binding(r).load;
const isSpent = (r) => Boolean(r.exhausted || r.invalid || load(r) >= 1);

const shortName = (name) => (name === 'five_hour' ? '5h' : name === 'seven_day' ? '7d' : name.replace(/^seven_day_/, '7d '));

// e.g. "OVER 7d 98%" for the window that crossed its line
function overLabel(r) {
  const { name } = binding(r);
  return name ? `OVER ${shortName(name)} ${Math.round(lineFor(name) * 100)}%` : 'OVER';
}

module.exports = { THRESHOLD_5H, THRESHOLD_WEEKLY, load, isSpent, binding, shortName, overLabel };
