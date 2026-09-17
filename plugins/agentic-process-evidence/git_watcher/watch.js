"use strict";

const fs = require("fs");
const path = require("path");
const { DATA } = require("../paths");
const { EventStore, defaultDbPath } = require("../local_storage/db");
const { WatchedGit } = require("../local_storage/watched_git");
const rec = require("../local_storage/session_objects_logic/record");

const STATE_PATH = process.env.GIT_WATCH_STATE || path.join(DATA, "git_watch_state.json");
const DEFAULT_POLL_SEC = Number(process.env.GIT_WATCH_POLL_SEC || 2);

function skipCid(cid) {
  if (!cid) return true;
  const s = String(cid);
  return s.endsWith("-probe") || s.startsWith("hook-") || s === "unknown";
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch {
    return { repos: {}, last_run: null };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, STATE_PATH);
}

function readHead(root) {
  try {
    const { spawnSync } = require("child_process");
    const out = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 });
    if (out.status !== 0) return null;
    return (out.stdout || "").trim() || null;
  } catch {
    return null;
  }
}

function detectNewCommits(roots, state, headFn) {
  state.repos = state.repos || {};
  const found = [];
  const read = headFn || readHead;
  for (const root of roots || []) {
    if (!root) continue;
    const sha = read(root);
    if (!sha) continue;
    const prev = state.repos[root] && state.repos[root].last_head;
    if (!prev) {
      state.repos[root] = { last_head: sha };
      continue;
    }
    if (prev !== sha) {
      found.push({ root, sha, previous: prev });
      state.repos[root] = { last_head: sha };
    }
  }
  return found;
}

function conversationsForRepo(events, repoRootPath) {
  const root = path.resolve(repoRootPath);
  const cids = new Set();
  for (const row of events || []) {
    const cid = row.conversation_id || row.session_id;
    if (skipCid(cid)) continue;
    const ag = row.affected_git;
    if (Array.isArray(ag) && ag.some((g) => g && g.root && path.resolve(g.root) === root)) {
      cids.add(cid);
      continue;
    }
    const roots = row.workspace_roots;
    if (Array.isArray(roots) && roots.some((r) => r && path.resolve(r) === root)) {
      cids.add(cid);
      continue;
    }
    if (typeof roots === "string" && path.resolve(roots) === root) {
      cids.add(cid);
      continue;
    }
    const cwd = row.cwd || (row.tool_input && row.tool_input.cwd);
    if (cwd && (cwd === root || String(cwd).startsWith(root + path.sep))) {
      cids.add(cid);
      continue;
    }
    const hashes = row.path_hashes || {};
    if (Object.keys(hashes).some((p) => p === root || p.startsWith(root + path.sep))) {
      cids.add(cid);
    }
  }
  return cids;
}

function stampHeadOnLogs(store, commits) {
  if (!store || typeof store.append !== "function") return [];
  const written = [];
  for (const commit of commits || []) {
    for (const cid of commit.cids || []) {
      if (skipCid(cid)) continue;
      const row = rec.normalize("gitHeadChanged", {
        hook_event_name: "gitHeadChanged",
        conversation_id: cid,
        git_head_change: {
          root: commit.root,
          git_dir: commit.git_dir || null,
          previous: commit.previous,
          sha: commit.sha,
          files: commit.files || [],
        },
        affected_git: [{
          root: commit.root,
          git_dir: commit.git_dir || null,
          previous: commit.previous,
          head: commit.sha,
        }],
      });
      store.append(row);
      written.push(row);
    }
  }
  return written;
}

function publishOnNewCommits(opts) {
  opts = opts || {};
  const exportFn = opts.exportSession || require("../artifactory_interface/export_session").exportSession;
  const report = { commits: opts.commits || [], published: [], skipped: [], errors: [] };
  for (const commit of opts.commits || []) {
    const cids = new Set(commit.cids || []);
    if (!cids.size) {
      for (const cid of conversationsForRepo(opts.events, commit.root)) cids.add(cid);
    }
    if (!cids.size) {
      report.skipped.push({ root: commit.root, sha: commit.sha, reason: "no_matching_sessions" });
      continue;
    }
    for (const cid of cids) {
      if (skipCid(cid)) continue;
      try {
        const out = exportFn(cid, { publish: opts.dryRun ? false : true, dryRun: Boolean(opts.dryRun) });
        const pub = (out && out.publish) || {};
        if (out && out.error && !pub.ok && !opts.dryRun) {
          report.errors.push({ conversation_id: cid, sha: commit.sha, error: out.error });
          continue;
        }
        report.published.push({
          conversation_id: cid,
          sha: commit.sha,
          root: commit.root,
          artifact: pub.target || (out && out.bundle_path) || null,
          dry_run: Boolean(opts.dryRun),
        });
      } catch (exc) {
        report.errors.push({ conversation_id: cid, sha: commit.sha, error: String(exc) });
      }
    }
  }
  return report;
}

function tick(opts) {
  opts = opts || {};
  const store = opts.store || new EventStore(defaultDbPath());
  const watched = opts.watched || new WatchedGit();
  const events = store.iterEvents();
  const state = opts.state || loadState();
  const persist = !opts.dryRun;
  const commits = opts.commits || watched.detectCommits({ persist });
  if (opts.roots) {
    for (const extra of detectNewCommits(opts.roots, state, opts.headFn)) {
      if (!commits.some((c) => c.root === extra.root && c.sha === extra.sha)) commits.push(extra);
    }
  }
  if (persist) stampHeadOnLogs(store, commits);
  const report = publishOnNewCommits({
    commits,
    events,
    exportSession: opts.exportSession,
    dryRun: opts.dryRun,
  });
  report.roots = watched.repos();
  report.files = watched.files().map((f) => f.path);
  report.commits = commits;
  state.last_run = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (persist) saveState(state);
  return report;
}

function sleepSec(sec) {
  if (sec <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(sec * 1000));
}

function runWatch(pollSec) {
  pollSec = pollSec != null ? pollSec : DEFAULT_POLL_SEC;
  process.stdout.write("[git_watcher] watch started poll=" + pollSec + "s state=" + STATE_PATH + "\n");
  while (true) {
    try {
      const report = tick();
      if ((report.commits && report.commits.length) || (report.published && report.published.length) || (report.errors && report.errors.length)) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      }
    } catch (exc) {
      process.stdout.write("[git_watcher] error: " + exc + "\n");
    }
    sleepSec(pollSec);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--watch")) {
    runWatch(args.includes("--poll") ? Number(args[args.indexOf("--poll") + 1]) : DEFAULT_POLL_SEC);
    return 0;
  }
  const report = tick({
    dryRun: args.includes("--dry-run"),
    roots: args.includes("--repo-root") ? [path.resolve(args[args.indexOf("--repo-root") + 1])] : null,
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return report.errors && report.errors.length ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  detectNewCommits,
  conversationsForRepo,
  stampHeadOnLogs,
  publishOnNewCommits,
  tick,
  runWatch,
  STATE_PATH,
};
