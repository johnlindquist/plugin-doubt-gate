# doubt-gate

A Claude Code **Stop hook plugin** that detects uncertainty in assistant messages. When doubt keywords (`likely`, `maybe`, `might`, `probably`, etc.) appear outside of code blocks and blockquotes, the hook blocks the stop and instructs the agent to add logging, assertions, or other verification before concluding.

This ensures the agent provides concrete evidence rather than speculation.

## How it works

Claude Code pipes a JSON payload to stdin on every Stop event. doubt-gate:

1. Strips fenced code blocks, inline code, and blockquotes from the assistant's last message
2. Scans the remaining prose for doubt keywords
3. If matches are found, prints `{"decision":"block","reason":"..."}` to stdout — Claude Code re-enters the conversation and must verify its claims
4. If no matches are found, exits silently — Claude Code stops normally

A `stop_hook_active` guard prevents infinite loops: if the hook already fired once for the current turn, the stop is always allowed through.

### Detected keywords

`likely`, `maybe`, `might`, `probably`, `possibly`, `not sure`, `not certain`, `uncertain`, `unclear`, `could be`, `appears to`, `seems like`, `I think`, `I believe`, `I suspect`, `it's possible`, `hard to say`

## Requirements

- **Node.js** >= 18 (the hook runs via `node`, not `bun`)
- **Claude Code** with plugin support (`--plugin-dir` flag)

## Install

### Option 1: Clone and use directly

```bash
git clone <repo-url> doubt-gate
claude --plugin-dir ./doubt-gate
```

### Option 2: Copy into your plugins directory

```bash
cp -r doubt-gate ~/.claude/plugins/doubt-gate
```

Then start Claude Code with:

```bash
claude --plugin-dir ./doubt-gate
```

The plugin registers itself as a Stop hook automatically via `.claude-plugin/plugin.json` and `hooks/hooks.json`.

## Environment variables

| Variable | Values | Default | Description |
|---|---|---|---|
| `DOUBT_GATE_LOG_LEVEL` | `off`, `info`, `debug` | `off` | Controls structured JSON log output |
| `DOUBT_GATE_LOG_PATH` | file path | `/tmp/doubt-gate.log` | Where log lines are written |

### Log levels

- **`off`** — No logging (default). Zero filesystem overhead.
- **`info`** — Logs each `allow` or `block` decision with session ID, matched keywords, and confidence count.
- **`debug`** — Everything in `info`, plus the stripped message text (first 500 chars) and full match list.

### Example log entry

```bash
DOUBT_GATE_LOG_LEVEL=info claude --plugin-dir ./doubt-gate
```

```json
{"ts":"2026-03-12T14:00:00.000Z","level":"info","event":"block","session":"abc-123","keyword":"might, probably","confidence":2}
```

## Plugin structure

```
doubt-gate/
├── .claude-plugin/
│   └── plugin.json        # Plugin metadata (name, version, description)
├── hooks/
│   ├── hooks.json         # Stop hook registration
│   └── doubt-gate.mjs     # Compiled hook (runs via node)
├── test/
│   ├── fixtures/          # Test input payloads
│   └── plugin.test.ts     # Integration tests (bun test)
├── package.json
└── README.md
```

## Testing

```bash
cd doubt-gate
bun test
```

### Manual verification

```bash
# Should output {"decision":"block","reason":"..."}
echo '{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"this might be wrong","session_id":"test","transcript_path":"","cwd":"/tmp"}' | node hooks/doubt-gate.mjs

# Should produce no output (clean message, no doubt)
echo '{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"the function returns 42","session_id":"test","transcript_path":"","cwd":"/tmp"}' | node hooks/doubt-gate.mjs
```

## License

MIT
