"use strict";

const fs = require("fs");
const path = require("path");
const { DATA } = require("../paths");
const { EventStore, defaultDbPath } = require("../local_storage/db");

const DEFAULT_INTERVAL = Number(process.env.SESSION_SYNC_INTERVAL_SEC || 300);
const DEFAULT_POLL_SEC = Number(process.env.SESSION_SYNC_POLL_SEC || 1);
const DEFAULT_DEBOUNCE_SEC = Number(process.env.SESSION_SYNC_DEBOUNCE_SEC || 3);
const STATE_PATH = process.env.SESSION_SYNC_STATE || path.join(DATA, "session_sync_state.json");

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return { conversations: {}, last_run: null }; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}
function utcTs() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function sleepSec(sec) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(sec * 1000));
}

function repoRootFilter() {
  const root = (process.env.SESSION_SYNC_REPO_ROOT || "").trim();
  return root ? path.resolve(root) : null;
}

function conversationsForRepo(store, repoRoot) {
  if (!repoRoot) return null;
  const root = path.resolve(repoRoot);
  const name = path.basename(root);
  const needles = [root, name, "context-as-artifacts", "context_as_artifacts"];
  const cids = new Set();
  for (const rec of store.iterEvents()) {
    const cid = rec.conversation_id || rec.session_id;
    if (!cid) continue;
    const blob = JSON.stringify(rec);
    if (needles.some((n) => n && blob.includes(n))) cids.add(cid);
  }
  return cids;
}

function syncOnce(opts) {
  opts = opts || {};
  const repoRoot = opts.repoRoot || repoRootFilter();
  const state = loadState();
  const convState = state.conversations || (state.conversations = {});
  const report = { checked: 0, published: [], skipped: [], errors: [] };
  let exportFn;
  try { exportFn = require("./export_session").exportSession; } catch (exc) {
    report.errors.push({ error: String(exc) });
    return report;
  }
  const store = new EventStore(defaultDbPath());
  const allowed = conversationsForRepo(store, repoRoot);
  for (const row of store.conversationStats()) {
    const cid = row.cid;
    const maxId = Number(row.max_id || 0);
    if (!cid || cid.endsWith("-probe") || cid.startsWith("hook-")) continue;
    if (allowed && !allowed.has(cid)) continue;
    report.checked += 1;
    const prevMax = Number((convState[cid] || {}).max_event_id || 0);
    if (maxId <= prevMax) {
      report.skipped.push({ conversation_id: cid, reason: "no_new_events" });
      continue;
    }
    if (opts.dryRun) {
      report.published.push({ conversation_id: cid, dry_run: true, max_event_id: maxId });
      convState[cid] = { max_event_id: maxId, last_ts: row.last_ts, last_sync: utcTs() };
      continue;
    }
    try {
      const out = exportFn(cid, { publish: opts.publish !== false });
      const manifest = out.manifest || {};
      const pub = out.publish || {};
      if (out.error && !pub.ok) {
        report.errors.push({ conversation_id: cid, error: out.error, max_event_id: maxId });
        continue;
      }
      convState[cid] = {
        max_event_id: maxId, last_ts: row.last_ts, last_sync: utcTs(),
        artifact: pub.target, policy_any_breach: (manifest.policy_summary || {}).any_breach,
      };
      report.published.push({
        conversation_id: cid, artifact: pub.target,
        policy_any_breach: convState[cid].policy_any_breach, max_event_id: maxId,
      });
    } catch (exc) {
      report.errors.push({ conversation_id: cid, error: String(exc) });
    }
  }
  state.last_run = utcTs();
  if (!opts.dryRun) saveState(state);
  report.state_path = STATE_PATH;
  return report;
}

function runWatch(pollSec, debounceSec) {
  pollSec = pollSec != null ? pollSec : DEFAULT_POLL_SEC;
  debounceSec = debounceSec != null ? debounceSec : DEFAULT_DEBOUNCE_SEC;
  process.stdout.write("[session_sync] watch started poll=" + pollSec + "s debounce=" + debounceSec + "s state=" + STATE_PATH + "\n");
  try {
    const report = syncOnce();
    if ((report.published && report.published.length) || (report.errors && report.errors.length)) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    }
  } catch (exc) {
    process.stdout.write("[session_sync] startup sync error: " + exc + "\n");
  }
  let lastSeen = new EventStore(defaultDbPath()).maxId();
  let lastChange = 0;
  let pending = false;
  while (true) {
    try {
      const current = new EventStore(defaultDbPath()).maxId();
      const now = Date.now() / 1000;
      if (current > lastSeen) {
        lastSeen = current;
        lastChange = now;
        pending = true;
      } else if (pending && now - lastChange >= debounceSec) {
        const report = syncOnce();
        pending = false;
        if ((report.published && report.published.length) || (report.errors && report.errors.length)) {
          process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        }
      }
    } catch (exc) {
      process.stdout.write("[session_sync] watch error: " + exc + "\n");
    }
    sleepSec(pollSec);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--watch")) {
    runWatch(
      args.includes("--poll") ? Number(args[args.indexOf("--poll") + 1]) : DEFAULT_POLL_SEC,
      args.includes("--debounce") ? Number(args[args.indexOf("--debounce") + 1]) : DEFAULT_DEBOUNCE_SEC
    );
    return 0;
  }
  if (args.includes("--daemon")) {
    const interval = args.includes("--interval") ? Number(args[args.indexOf("--interval") + 1]) : DEFAULT_INTERVAL;
    process.stdout.write("[session_sync] daemon started interval=" + interval + "s state=" + STATE_PATH + "\n");
    while (true) {
      try {
        const report = syncOnce();
        if ((report.published && report.published.length) || (report.errors && report.errors.length)) {
          process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        } else process.stdout.write("[session_sync] no changes\n");
      } catch (exc) {
        process.stdout.write("[session_sync] error: " + exc + "\n");
      }
      sleepSec(interval);
    }
  }
  const report = syncOnce({
    dryRun: args.includes("--dry-run"),
    publish: !args.includes("--no-publish"),
    repoRoot: args.includes("--repo-root") ? args[args.indexOf("--repo-root") + 1] : null,
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return report.errors && report.errors.length ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { syncOnce, runWatch };
