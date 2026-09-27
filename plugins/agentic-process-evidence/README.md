# Agentic process evidence (clientside)

Cursor plugin that records an agent session, binds file changes to git, and ships a session bundle to Artifactory. Node stdlib only (`fs`, `crypto`, `child_process`, `http`). System bins: `git`, `jf`, `tar`.

Pipeline: [`flow.md`](flow.md).

## Install locally

Cursor skips symlinks in `~/.cursor/plugins/local` that point outside that folder, so copy the directory in:

```bash
cp -R plugins/agentic-process-evidence ~/.cursor/plugins/local/agentic-process-evidence
```

Then run **Developer: Reload Window** (or restart Cursor). Session events write to `~/.cursor/agentic-bom/events.jsonl` without `hooks/install.js` — that script is only for merging into `~/.cursor/hooks.json` outside the plugin.

For `cursor-agent`:

```bash
cursor-agent --plugin-dir "$PWD/plugins/agentic-process-evidence"
```

Optional companions (not started by the plugin):

```bash
node viewer/zen_server.js               # http://localhost:8790
node git_watcher/watch.js --watch       # upload to RT when a watched .git HEAD moves
```

## Directories

| Dir | Responsibility |
|---|---|
| `hooks/` | Talk to the agent runtime: install Cursor hooks, consume stdin JSON, fail-open decisions. |
| `local_storage/` | Intake + persist: shape records, JSONL spool, and a **watched-git collection** of repos (`.git` + logged HEAD + session ids). |
| `change_detector/` | Guess write paths from tool/shell payloads and compare pre/post content SHA-256. |
| `git_finder/` | Map a changed path to repo, branch, HEAD, remote, and last-touch commit. Stamps `affected_git` on the log. |
| `git_watcher/` | Poll HEAD of watched repos. Logged SHA → new SHA: stamp logs and upload those sessions. |
| `artifactory_interface/` | Build the session-bundle `.tgz`, `jf rt upload`, commit indexes. Bundle logic lives here. |
| `viewer/` | Local zen UI over the spool (`:8790`): timeline, file-change, git. |

`paths.js` resolves the global data dir and spool path (`~/.cursor/agentic-bom/` after install).

## Data

Event store: `$MONITORING_DB`, else `monitoring_db` in `~/.cursor/agentic-bom/settings.json`, else `~/.cursor/agentic-bom/events.jsonl`. Watched git: same path + `.watched_git.json`.

Do not also run `node hooks/install.js` while the plugin is enabled — that would register the same hooks twice via `~/.cursor/hooks.json`.

## How git changes are detected

1. On `preToolUse` / `postToolUse`, `change_detector` hashes extracted paths and compares content SHA-256.
2. If a digest changed, `git_finder` writes `affected_git` (repo, branch, HEAD, remote, last-touch commit) onto that event and adds that `.git` to the watched collection. Logged SHA is HEAD at that moment.
3. `git_watcher` polls every 2s: `git rev-parse HEAD` vs stored `logged_sha`.
4. HEAD ≠ logged SHA → append `gitHeadChanged` onto each matching session log, then upload all of those sessions.

Not a filesystem watcher. Not `git push`. Detects **local commits that move a watched repo HEAD**.

## Env

| Var | Default |
|---|---|
| `MONITORING_DB` | `~/.cursor/agentic-bom/events.jsonl` (after install) |
| `AGENTIC_BOM_DATA` | `~/.cursor/agentic-bom` |
| `JF_SERVER` | active `jf` CLI server (`jf config use`) |
| `JF_ARTIFACTORY_URL` | Artifactory URL of that `jf` server |
| `SESSION_AUDIT_REPO` | `agentic-policies` |
| `APPTRUST_LIVE_PUBLISH` | `0` (`1` re-enables hook-triggered upload) |
| `WATCHED_GIT` | `$MONITORING_DB.watched_git.json` |
| `GIT_WATCH_POLL_SEC` | `2` |
| `ZEN_PORT` | `8790` |
