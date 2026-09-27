#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { installGlobalData, SETTINGS_PATH, GLOBAL_DIR } = require("../paths");

const HERE = __dirname;
const LOG_EVENT = path.join(HERE, "log_event.js");
const RUNNER = path.join(GLOBAL_DIR, "run-hook.sh");
const EVENTS = [
  "sessionStart", "sessionEnd", "beforeSubmitPrompt", "afterAgentResponse", "afterAgentThought",
  "preToolUse", "postToolUse", "postToolUseFailure", "beforeShellExecution", "afterShellExecution",
  "beforeMCPExecution", "afterMCPExecution", "beforeReadFile", "afterFileEdit",
  "subagentStart", "subagentStop", "preCompact", "stop",
];

function writeRunner() {
  const body = "#!/bin/sh\nexec node " + JSON.stringify(LOG_EVENT) + ' "$@"\n';
  fs.mkdirSync(path.dirname(RUNNER), { recursive: true });
  fs.writeFileSync(RUNNER, body);
  fs.chmodSync(RUNNER, 0o755);
  return RUNNER;
}

function command(event) {
  return RUNNER + " " + event;
}

function isOurs(entry) {
  const cmd = (entry && entry.command) || "";
  return cmd.includes(LOG_EVENT) || cmd.includes(RUNNER)
    || (cmd.includes("log_event.js") && (
      cmd.includes("agentic-process-evidence-clientside")
      || cmd.includes("client_side_production")
    ));
}

function mergeHooks(existing, ours) {
  const payload = existing && typeof existing === "object" ? Object.assign({}, existing) : {};
  payload.version = payload.version || 1;
  const hooks = Object.assign({}, payload.hooks || {});
  for (const [event, entries] of Object.entries(ours)) {
    const current = (hooks[event] || []).filter((e) => !isOurs(e));
    hooks[event] = current.concat(entries);
  }
  payload.hooks = hooks;
  return payload;
}

function install(dest) {
  const ours = {};
  for (const ev of EVENTS) ours[ev] = [{ command: command(ev) }];
  let existing = {};
  if (fs.existsSync(dest)) existing = JSON.parse(fs.readFileSync(dest, "utf8"));
  const merged = mergeHooks(existing, ours);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(merged, null, 2) + "\n");
  fs.chmodSync(LOG_EVENT, 0o755);
  return dest;
}

function main() {
  const args = process.argv.slice(2);
  const skipGlobal = args.includes("--no-global");
  const ws = args.includes("--workspace") ? args[args.indexOf("--workspace") + 1] : null;
  const dataDir = args.includes("--data-dir") ? args[args.indexOf("--data-dir") + 1] : null;
  if (skipGlobal && !ws) {
    console.error("pass --workspace DIR, or omit --no-global to install ~/.cursor/hooks.json");
    process.exit(2);
  }
  const settings = installGlobalData({ dataDir: dataDir || undefined });
  writeRunner();
  const written = [];
  if (!skipGlobal) written.push(install(path.join(os.homedir(), ".cursor", "hooks.json")));
  if (ws) written.push(install(path.join(path.resolve(ws), ".cursor", "hooks.json")));
  console.log("wrote", SETTINGS_PATH);
  console.log("wrote", RUNNER);
  console.log("spool", settings.monitoring_db);
  for (const p of written) console.log("wrote", p);
}

if (require.main === module) main();
