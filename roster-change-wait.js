// Sleeps until a delay elapses or cswap's roster (sequence.json) changes: a slot added or removed, or a manual
// `cswap switch`. That way a newly added token is used within seconds instead of at the next scheduled probe.
// Polls mtime+size rather than fs.watch: cswap replaces the file by atomic rename, which fs.watch reports
// inconsistently across OSes. Polling a stat costs nothing and makes no API calls.
const fs = require('fs');

const POLL_MS = 5000;

function stamp(file) {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'missing';
  }
}

// Resolves 'roster-changed' or 'timeout'. Take the baseline right after a tick so the watcher's own
// `cswap switch` (made inside the tick) doesn't count as an outside change.
function waitForRosterChangeOrTimeout(file, ms, baseline = stamp(file), pollMs = POLL_MS) {
  return new Promise((resolve) => {
    const done = (why) => { clearInterval(poll); clearTimeout(timeout); resolve(why); };
    const poll = setInterval(() => { if (stamp(file) !== baseline) done('roster-changed'); }, pollMs);
    const timeout = setTimeout(() => done('timeout'), ms);
  });
}

module.exports = { waitForRosterChangeOrTimeout, stamp };
