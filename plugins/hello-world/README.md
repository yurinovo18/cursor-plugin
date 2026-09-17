# Hello World

The smallest useful Cursor plugin: a single Node.js hook that says hello.

## What it does

`hooks/hooks.json` registers one `sessionStart` hook that runs
`node ./scripts/hello-world.mjs`. The script reads the hook payload from stdin,
appends it to a log file, and returns:

```json
{ "additional_context": "Hello, world from the hello-world plugin! (sessionStart)" }
```

`additional_context` is injected into the conversation, so asking the agent
"what context were you given?" at the start of a fresh chat will surface the
greeting.

## Layout

```text
plugins/hello-world/
├── .cursor-plugin/
│   └── plugin.json          # manifest — only `name` is strictly required
├── hooks/
│   └── hooks.json           # discovered by convention; no manifest wiring needed
├── scripts/
│   └── hello-world.mjs      # stdin JSON in, stdout JSON out
└── README.md
```

## Install locally

Cursor skips symlinks in `~/.cursor/plugins/local` that point outside that
folder, so copy the directory in:

```bash
cp -R plugins/hello-world ~/.cursor/plugins/local/hello-world
```

Then run **Developer: Reload Window** (or restart Cursor) and open a new chat.

For `cursor-agent`, point at the checkout directly instead of copying:

```bash
cursor-agent --plugin-dir "$PWD/plugins/hello-world"
```

## Verify it ran

```bash
tail -f "${TMPDIR:-/tmp}/cursor-hello-world.log"
```

Set `HELLO_WORLD_LOG` to log somewhere else. The **Hooks** output channel and the
**Hooks** tab in Customize show registration and execution errors.

## Test without Cursor

```bash
echo '{"hook_event_name":"sessionStart","session_id":"demo"}' \
  | node plugins/hello-world/scripts/hello-world.mjs
```

## Notes

- `sessionStart` is fire-and-forget — it cannot block the session, and it does
  not run in cloud agents.
- Relative commands in a plugin's `hooks.json` resolve against the plugin root.
  The script logs to the temp dir rather than a relative path so it works
  regardless of the working directory.
