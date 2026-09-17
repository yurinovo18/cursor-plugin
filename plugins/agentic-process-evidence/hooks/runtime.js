"use strict";

const rec = require("../local_storage/session_objects_logic/record");

const PERMISSION_EVENTS = new Set([
  "preToolUse",
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "subagentStart",
]);
const CONTINUE_EVENTS = new Set(["beforeSubmitPrompt"]);

function readPayload() {
  const raw = fsReadStdin();
  if (!raw || !raw.trim()) return {};
  try {
    const payload = JSON.parse(raw);
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : { _value: payload };
  } catch {
    return { _unparsed_stdin: raw };
  }
}

function fsReadStdin() {
  try {
    return require("fs").readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function passthrough(event) {
  if (PERMISSION_EVENTS.has(event)) return { permission: "allow", continue: true };
  if (CONTINUE_EVENTS.has(event)) return { continue: true };
  return {};
}

function emit(response) {
  process.stdout.write(JSON.stringify(response) + "\n");
}

class Handler {
  handle() {
    return null;
  }
}

class Context {
  constructor(event, projectRoot) {
    this.event = event;
    this.project_root = projectRoot;
    this.state = {};
  }
  warn(msg) {
    process.stderr.write("hookkit: " + msg + "\n");
  }
}

function merge(base, decision) {
  if (!decision || decision.allow !== false) return base;
  const resp = Object.assign({}, base);
  resp.continue = false;
  if ("permission" in resp) resp.permission = "deny";
  if (decision.message) resp.user_message = decision.message;
  return resp;
}

function run(event, handlers, opts = {}) {
  const payload = opts.payload != null ? opts.payload : readPayload();
  const record = rec.normalize(event, payload);
  const resolved = rec.eventName(record);
  const ctx = new Context(resolved, opts.projectRoot);
  let response = passthrough(resolved);
  let denied = null;
  for (const handler of handlers) {
    let decision = null;
    try {
      decision = handler.handle(record, ctx);
    } catch (exc) {
      ctx.warn((handler.constructor && handler.constructor.name) + " raised: " + exc);
    }
    if (decision && decision.allow === false && !denied) denied = decision;
  }
  response = merge(response, denied);
  if (opts.emit !== false) emit(response);
  return response;
}

module.exports = { Handler, Context, run, readPayload, passthrough, emit };
