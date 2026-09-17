Cursor hook adapter. Stdin JSON in, fail-open, write event spool.
Owns: `hooks.json`, `install.js`, `runtime.js`, and `log_event.js` (hash → git bind → store → optional live publish). Not session record shape, Git, or viewer.
Entry: `log_event.js <event>`, `install.js` → `~/.cursor/hooks.json` + `~/.cursor/agentic-bom/settings.json` + `run-hook.sh`
