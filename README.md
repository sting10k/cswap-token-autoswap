# cswap-token-autoswap

Automatically rotates Claude Code between several long-lived subscription tokens (`claude setup-token`)
when the active one nears or hits its quota. It builds on [claude-swap](https://github.com/realiti4/claude-swap) (`cswap`).

Running Claude Code sessions, including Paseo agents, pick up the new token on their next request. You don't
need to restart anything.

## Why this exists

`cswap auto` decides when to switch by reading `/api/oauth/usage`. Tokens from `setup-token` only have the
`user:inference` scope, so that endpoint returns 403 for them, and `/usage` can't show their quota either. As a
result, `cswap auto` can't rotate setup-token slots on its own.

This watcher measures quota with the official Claude Code binary instead:

1. It runs `claude -p` with `CLAUDE_CODE_OAUTH_TOKEN=<token>` and `--output-format stream-json`.
2. It reads the `rate_limit_event` from that output, which contains the utilization of every quota window.
3. When the active token is close to its limit, it calls `cswap switch <n>`.

The script never calls the API directly. Tokens are only ever used by Claude Code itself.

## Requirements

- Node.js >= 18
- Claude Code CLI (`claude`) on `PATH`
- claude-swap (`cswap`) >= 0.27 (tested up to 1.1.0; keep `usage.headerProbe` off), Python >= 3.12. Install it via uv as shown below.

## Install

### 1. Install uv + claude-swap

Linux / macOS:
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh      # installs uv into ~/.local/bin
uv tool install claude-swap                          # provides `cswap` (and `claude-swap`)
cswap --version
```

Windows (PowerShell):
```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
uv tool install claude-swap
cswap --version
```

`pipx install claude-swap` also works. To upgrade later, run `cswap upgrade` (or `uv tool upgrade claude-swap`).

### 2. Register one setup-token per account

```bash
claude setup-token                 # run once per account (log in as that account in the browser)
cswap add-token sk-ant-oat01-...   # or pipe the token in: echo "$TOKEN" | cswap add-token -
cswap list                         # token slots show "usage unavailable (http-403/429)", which is expected
cswap switch <n>                   # activate one token slot (writes ~/.claude/.credentials.json)
```

- Do not set `CLAUDE_CODE_OAUTH_TOKEN` in the environment or in `settings.json`. It overrides the
  credentials file that cswap swaps.
- Optional: remove any `/login` slot (`cswap remove <n>`) so only token slots are in rotation. If the active slot
  is a `/login` slot, the watcher moves onto the token pool on its next tick.

### 3. Get the watcher and run it as a service

```bash
git clone https://github.com/sting10k/cswap-token-autoswap.git
cd cswap-token-autoswap
node token-autoswap-watcher.js --once   # one tick in the foreground, prints the decision
```

Linux (systemd user service, keeps running after logout):
```bash
./deploy/install-linux-systemd.sh
journalctl --user -u cswap-token-autoswap -f
```

macOS (launchd LaunchAgent `com.cswap-token-autoswap`: starts at login, restarted if it exits):
```bash
./deploy/install-macos-launchd.sh
tail -f autoswap.log
```

Windows (Scheduled Task `ClaudeTokenAutoswap`: starts at logon, with a 5-minute watchdog):
```powershell
powershell -ExecutionPolicy ByPass -File deploy\install-windows-task.ps1
```

## Behaviour

- **What gets probed.** Only the active token is probed on a schedule. Each probe is one tiny Haiku turn, about
  $0.0007. Idle tokens are probed only right before a switch.
- **Separate switch lines per window.** The 5-hour window switches at **90%**; the weekly windows (7d and
  per-model weekly) at **98%**. The last 10% of a week's budget is far more work than the last 10% of a 5-hour
  window, so a slot at `5h 0% / 7d 90%` is still a good target. Each window is judged against its own line, and
  *load* is the binding window's utilization divided by its line (1.0 = at the line).
- **Adaptive cadence** (±10% jitter so probes don't land on a fixed grid):

  | Situation | Next probe in |
  |---|---|
  | Load < 78% (5h < ~70%) | 15 min |
  | Load 78–94% | 5 min |
  | Load ≥ 94% (5h ≥ ~85%), or up ≥ 5 points since the last probe | 2 min |
  | Probe error | 5 min |
  | Blocked while the active token still serves | 2 min |
  | Every token dead (rejected/invalid) | 10 min |

- **When it switches:** any window reaches its line, status `rejected`/429, or an invalid token (401/403).
- **Which token it picks:** the token with the lowest load that is under all its lines. There is a 2-minute
  cooldown between threshold-based switches.
- **When every other token is also over the threshold:**
  - While the active token still serves, the watcher stays on it and `status.json` shows `blocked`. Moving
    between near-full tokens would only burn probes.
  - Once the active token stops serving (`rejected`/429, or invalid), it escapes to the slot with the most room
    left that still answers, even if that slot is over the threshold (state `escaped: all tokens over threshold`).
  - While blocked and the active token still serves, it is re-checked every 2 minutes (it is close to dying), and
    every slot is re-checked each time. The watcher switches as soon as one drops back under its lines after a reset.
- **Manual switches are respected.** Each tick reads the active slot from cswap, so `cswap switch` by hand is fine.
- **Limitation:** a token can still hit a 429 between two probes. That one agent turn fails; the next probe
  switches, and you re-send the prompt. Paseo marks such a turn as `completed`, not `error`.

Verified 2026-10-15 on Windows: a running Paseo agent served turn 1 with token A. The credentials file was then
changed, and the same process served the next turn with the new credentials, without a restart.

## Platform notes

| | Windows | Linux | macOS |
|---|---|---|---|
| cswap data dir | `~/.claude-swap-backup` | `$XDG_DATA_HOME/claude-swap` (default `~/.local/share/claude-swap`) | `~/.claude-swap-backup` |
| Stored slot tokens | `.enc` files | `.enc` files | Keychain (service `claude-swap`), `.enc` only as fallback |
| Live credential that cswap swaps | `~/.claude/.credentials.json` | `~/.claude/.credentials.json` | Keychain item `Claude Code-credentials` |
| Service | Scheduled Task | systemd user unit | launchd LaunchAgent |
| Tested | ✅ including hot reload in a running Paseo agent | ✅ watcher + switch + `claude -p` | ⚠️ not tested on a Mac yet |

On macOS, the watcher reads slot tokens with `/usr/bin/security`, the same binary cswap uses to write them, so there
should be no Keychain prompt. It has **not been verified** whether an already-running Claude Code process notices a
Keychain change without a restart (on Windows and Linux it re-reads the credentials file). Test this once on a Mac
before relying on it.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `AUTOSWAP_THRESHOLD` | `0.9` | Switch line for the 5-hour window |
| `AUTOSWAP_WEEKLY_THRESHOLD` | `0.98` | Switch line for the weekly windows (7d and per-model) |
| `AUTOSWAP_SLOW_S` / `_MID_S` / `_FAST_S` | `900` / `300` / `120` | Cadence tiers |
| `AUTOSWAP_COOLDOWN_S` | `120` | Minimum gap between threshold-based switches |
| `AUTOSWAP_PROBE_MODEL` | `haiku` | Model used for the probe turn |
| `AUTOSWAP_CLAUDE_BIN` | `claude` | Claude Code binary |
| `CSWAP_BIN` | `cswap` | claude-swap binary |
| `CSWAP_BACKUP_DIR` | Linux: `$XDG_DATA_HOME/claude-swap` (`~/.local/share/claude-swap`); else `~/.claude-swap-backup` | cswap data directory (same rule as cswap) |

## Operations

### Check quota

```bash
node token-autoswap-watcher.js --quota          # from the running watcher's status.json: free, no request
node token-autoswap-watcher.js --quota --fresh  # probe every slot now (~$0.0007 each); never switches
```

```
Fresh probe of 2 slot(s) · switch lines 5h 90% / weekly 98% · * = active
SLOT     STATUS        5H   RESETS     7D   RESETS      AS OF
2     *  OVER 5h 90%   91%  in 1h 12m  12%  in 9h 2m    0m ago
3        allowed       0%   in 4h 38m  90%  in 1d 6h    0m ago
```

Without `--fresh`, idle slots only have the reading from the last switch (or `unprobed` after a restart).
Don't use `cswap list` for this: setup-token slots show `usage unavailable` there unless `usage.headerProbe` is
on, and that probe would run alongside this watcher's.

### Other

- Status: `status.json` (active slot, last reading per slot, `nextProbeAt`)
- Log: `autoswap.log` (switches and state changes only)
- One-shot tick: `node token-autoswap-watcher.js --once`
- Single instance is enforced via `watcher.pid`

## Files

| File | Role |
|---|---|
| `token-autoswap-watcher.js` | Main loop: probe, decide, switch, adaptive cadence |
| `setup-token-quota-probe.js` | Runs `claude -p` and parses `rate_limit_event` |
| `quota-policy.js` | Per-window switch lines, load, "spent" test (shared by the watcher and `--quota`) |
| `quota-report.js` | `--quota` table (from `status.json`, or `--fresh` probes of every slot) |
| `cswap-account-store.js` | Reads cswap's roster and stored tokens; switches via the `cswap` CLI |
| `deploy/` | Installers: systemd (Linux), launchd (macOS), Scheduled Task (Windows) |

## Uninstall

Linux:
```bash
systemctl --user disable --now cswap-token-autoswap.service
rm ~/.config/systemd/user/cswap-token-autoswap.service && systemctl --user daemon-reload
```

macOS:
```bash
launchctl bootout "gui/$(id -u)/com.cswap-token-autoswap"
rm ~/Library/LaunchAgents/com.cswap-token-autoswap.plist
```

Windows:
```powershell
Unregister-ScheduledTask ClaudeTokenAutoswap -Confirm:$false
Stop-Process -Id (Get-Content .\watcher.pid)
```

## Policy note

Automatically rotating several subscription accounts to exceed usage limits is a grey area under Anthropic's
terms. Only use tokens of accounts you own, and never share or resell them. See
<https://code.claude.com/docs/en/legal-and-compliance>.
