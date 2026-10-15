// Reads live quota of a Claude subscription OAuth token (incl. `claude setup-token` tokens,
// which the usage endpoint rejects with 403) by running the official Claude Code binary
// (`claude -p`, token passed via CLAUDE_CODE_OAUTH_TOKEN) and parsing its `rate_limit_event`
// stream-json message. No direct API calls: the token is only ever used by Claude Code itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLAUDE_BIN = process.env.AUTOSWAP_CLAUDE_BIN || 'claude';
const PROBE_MODEL = process.env.AUTOSWAP_PROBE_MODEL || 'haiku';
const PROBE_TIMEOUT_MS = 90000;
// Empty cwd so the probe session picks up no project CLAUDE.md / settings
const PROBE_CWD = path.join(os.tmpdir(), 'cswap-autoswap-probe');

const ARGS = [
  '-p', '.',
  '--model', PROBE_MODEL,
  '--output-format', 'stream-json', '--verbose',
  '--no-session-persistence', '--strict-mcp-config', '--tools', '', '--setting-sources', '',
];

// Runs one probe turn; resolves with the parsed stream-json events. Kills the process early on an
// auth/quota failure so Claude Code's built-in retry loop (up to 10 attempts) doesn't stall the watcher.
function runClaude(token) {
  fs.mkdirSync(PROBE_CWD, { recursive: true });
  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, MAX_THINKING_TOKENS: '0' };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ARGS, { cwd: PROBE_CWD, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const events = [];
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('probe timeout')); }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        events.push(ev);
        const fatalRetry = ev.type === 'system' && ev.subtype === 'api_retry' && [401, 403, 429].includes(ev.error_status);
        const rejected = ev.type === 'rate_limit_event' && ev.rate_limit_info?.status === 'rejected';
        if (fatalRetry || rejected) child.kill();
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, events, stderr }); });
  });
}

// Returns { httpStatus, quotaStatus, util5h, util7d, utilPeak, reset5h, reset7d, windows, invalid, exhausted, error }
async function probeToken(token) {
  const { code, events, stderr } = await runClaude(token);
  const rl = events.filter((e) => e.type === 'rate_limit_event').pop()?.rate_limit_info;
  const retry = events.filter((e) => e.type === 'system' && e.subtype === 'api_retry').pop();
  const windows = rl?.unifiedWindows || {};
  const utils = Object.values(windows).map((w) => w?.utilization).filter((v) => typeof v === 'number');

  const result = {
    httpStatus: retry?.error_status ?? (rl ? 200 : null),
    quotaStatus: rl?.status || null,
    util5h: windows.five_hour?.utilization ?? null,
    util7d: windows.seven_day?.utilization ?? null,
    utilPeak: utils.length ? Math.max(...utils) : null,
    reset5h: windows.five_hour?.resetsAt ?? null,
    reset7d: windows.seven_day?.resetsAt ?? null,
    windows,
  };
  result.invalid = result.httpStatus === 401 || result.httpStatus === 403;
  result.exhausted = rl?.status === 'rejected' || result.httpStatus === 429;
  if (!rl && !result.invalid && !result.exhausted) {
    // No quota signal at all (network down, CLI broke...) -> caller treats as transient
    throw new Error(`no rate_limit_event (exit ${code}${retry ? `, api ${retry.error_status} ${retry.error}` : ''}) ${stderr.trim().slice(0, 200)}`);
  }
  if (retry && (result.invalid || result.exhausted)) result.error = `api ${retry.error_status} ${retry.error}`;
  return result;
}

module.exports = { probeToken };

if (require.main === module) {
  // Manual test: node setup-token-quota-probe.js <token>   (or token via PROBE_TOKEN env)
  const token = process.argv[2] || process.env.PROBE_TOKEN;
  probeToken(token).then((r) => console.log(JSON.stringify(r, null, 2)), (e) => { console.error(e.message); process.exit(1); });
}
