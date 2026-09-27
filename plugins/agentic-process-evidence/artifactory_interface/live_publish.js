"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Handler } = require("../hooks/runtime");
const { DATA } = require("../paths");

const LOG_PATH = path.join(DATA, "live_publish.log");
const STATE_PATH = path.join(DATA, "live_publish_state.json");
const SYNC_STATE_PATH = path.join(DATA, "session_sync_state.json");
const DEFAULT_DEBOUNCE_SEC = Number(process.env.APPTRUST_PUBLISH_DEBOUNCE_SEC || 8);
const TRIGGER_EVENTS = new Set([
  "beforeSubmitPrompt", "afterFileEdit", "afterShellExecution",
  "afterAgentResponse", "stop", "sessionEnd",
]);
const FLUSH_EVENTS = new Set(["stop", "sessionEnd"]);

function enabled() {
  for (const key of ["APPTRUST_LIVE_PUBLISH", "APPTRUST_PUBLISH_ON_STOP"]) {
    if (key in process.env) {
      const raw = String(process.env[key] || "0").toLowerCase();
      return !["0", "false", "no", "off"].includes(raw);
    }
  }
  return false;
}

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

function saveJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

function log(row) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(row) + "\n");
}

function skipCid(cid) {
  if (!cid) return true;
  const s = String(cid);
  return s.endsWith("-probe") || s.startsWith("hook-");
}

function utcTs() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sleepSec(sec) {
  if (sec <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(sec * 1000));
}

function publishNow(cid) {
  const { exportSession } = require("./export_session");
  const out = exportSession(cid, { publish: true });
  const pub = out.publish || {};
  const manifest = out.manifest || {};
  const row = {
    ts: utcTs(), conversation_id: cid, ok: Boolean(pub.ok),
    target: pub.target, error: out.error || pub.error,
    commit_shas: manifest.commit_shas || [],
  };
  log(row);
  if (pub.ok) {
    try {
      const { EventStore, defaultDbPath } = require("../local_storage/db");
      const store = new EventStore(defaultDbPath());
      const sync = loadJson(SYNC_STATE_PATH, { conversations: {} });
      sync.conversations = sync.conversations || {};
      sync.conversations[cid] = {
        max_event_id: store.maxIdFor(cid), last_ts: store.lastTsFor(cid),
        last_sync: row.ts, artifact: pub.target, source: "live_publish",
      };
      sync.last_run = row.ts;
      saveJson(SYNC_STATE_PATH, sync);
    } catch (exc) {
      log({ conversation_id: cid, ok: true, state_error: String(exc) });
    }
  }
  return row;
}

function schedule(cid, event, immediate) {
  if (!enabled() || skipCid(cid)) return;
  const state = loadJson(STATE_PATH, { conversations: {} });
  const conv = state.conversations || (state.conversations = {});
  const bucket = conv[cid] || (conv[cid] = { gen: 0 });
  bucket.gen = Number(bucket.gen || 0) + 1;
  bucket.event = event;
  const gen = bucket.gen;
  saveJson(STATE_PATH, state);
  const debounce = immediate ? 0 : DEFAULT_DEBOUNCE_SEC;
  fs.mkdirSync(DATA, { recursive: true });
  const logFd = fs.openSync(LOG_PATH, "a");
  const child = spawn(
    process.execPath,
    [path.resolve(__filename), "--flush", String(cid), String(gen), String(debounce)],
    { stdio: ["ignore", logFd, logFd], detached: true, env: process.env }
  );
  child.unref();
  fs.closeSync(logFd);
}

function flushWorker(cid, gen, debounce) {
  sleepSec(debounce);
  const state = loadJson(STATE_PATH, { conversations: {} });
  const bucket = ((state.conversations || {})[cid]) || {};
  if (Number(bucket.gen || 0) !== Number(gen)) return 0;
  try {
    return publishNow(cid).ok ? 0 : 1;
  } catch (exc) {
    log({ conversation_id: cid, ok: false, error: String(exc) });
    return 1;
  }
}

class LivePublishHandler extends Handler {
  handle(record, ctx) {
    if (!enabled()) return null;
    const event = (record && record.event) || (ctx && ctx.event) || "";
    if (!TRIGGER_EVENTS.has(event)) return null;
    const cid = (record && (record.conversation_id || record.session_id)) || "";
    if (skipCid(cid)) return null;
    try { schedule(cid, event, FLUSH_EVENTS.has(event)); }
    catch (exc) { if (ctx) ctx.warn("live_publish schedule failed: " + exc); }
    return null;
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--flush") {
    process.exit(flushWorker(argv[1] || "", Number(argv[2] || 0), Number(argv[3] || DEFAULT_DEBOUNCE_SEC)));
  }
  process.stdout.write('{"continue": true}\n');
}

module.exports = { LivePublishHandler, publishNow, enabled };
