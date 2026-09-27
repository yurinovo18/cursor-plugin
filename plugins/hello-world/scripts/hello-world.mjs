// Hello-world Cursor hook.
//
// Reads the hook payload from stdin, appends a line to a log file so you can
// confirm the hook actually fired, and prints a `sessionStart` response that
// injects a greeting into the conversation.
//
// Log location: $TMPDIR/cursor-hello-world.log (override with HELLO_WORLD_LOG).

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const LOG_PATH = process.env.HELLO_WORLD_LOG || path.join(tmpdir(), "cursor-hello-world.log");

/** Collect stdin as a string; hooks always receive a single JSON object. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {string} raw — the JSON payload Cursor wrote to stdin
 * @returns {Record<string, unknown>}
 */
function parsePayload(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

const payload = parsePayload(await readStdin());
const event = payload.hook_event_name ?? "unknown";
const greeting = `Hello, world from the hello-world plugin! (${event})`;

// Never let a logging failure turn into a hook failure.
try {
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${event} ${JSON.stringify(payload)}\n`);
} catch {}

process.stdout.write(JSON.stringify({ additional_context: greeting }));
