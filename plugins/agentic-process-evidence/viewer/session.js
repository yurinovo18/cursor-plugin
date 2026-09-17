"use strict";

const fs = require("fs");
const path = require("path");
const rec = require("../local_storage/session_objects_logic/record");
const paths = require("../change_detector/path_extractor");
const { EventStore, defaultDbPath } = require("../local_storage/db");
const gitmeta = require("../git_finder/gitmeta");

const DB_PATH = process.env.MONITORING_DB || defaultDbPath();
const FILE_CHANGE_TOOLS = new Set(["Write", "StrReplace", "Edit", "MultiEdit", "Delete", "EditNotebook"]);
const TIMELINE_KINDS = {
  beforeSubmitPrompt: "prompt",
  afterAgentResponse: "response",
  afterAgentThought: "thought",
  preToolUse: "tool",
};

function trimForViewer(obj, maxStr, depth) {
  maxStr = maxStr || 6000;
  depth = depth || 0;
  if (depth > 6) return null;
  if (typeof obj === "string") return obj.length <= maxStr ? obj : obj.slice(0, maxStr) + "…";
  if (Array.isArray(obj)) return obj.slice(0, 80).map((x) => trimForViewer(x, maxStr, depth + 1));
  if (obj && typeof obj === "object") {
    const out = {};
    let n = 0;
    for (const k of Object.keys(obj)) {
      if (n++ >= 80) break;
      out[k] = trimForViewer(obj[k], maxStr, depth + 1);
    }
    return out;
  }
  return obj;
}

function buildPulse() {
  if (!fs.existsSync(DB_PATH)) {
    return { db_path: DB_PATH, empty: true, event_total: 0, conversations: [] };
  }
  const store = new EventStore(DB_PATH);
  return { db_path: DB_PATH, empty: false, event_total: store.count(), conversations: store.conversations() };
}

function remotesFromCoords(pairs) {
  const groups = {};
  for (const [filePath, g] of pairs) {
    if (!g || !g.resolved) continue;
    const p = filePath || g.path;
    const key = g.remote || g.root || p;
    let grp = groups[key];
    if (!grp) {
      grp = groups[key] = {
        remote: g.remote, name: g.name, root: g.root, branch: g.branch, head_short: g.head_short,
        files: new Set(), commits: {},
      };
    }
    if (p) grp.files.add(p);
    const lc = g.last_commit;
    if (lc && lc.sha) {
      let commit = grp.commits[lc.sha];
      if (!commit) {
        commit = grp.commits[lc.sha] = {
          sha: lc.sha, short: lc.short, subject: lc.subject, author: lc.author, date: lc.date, files: new Set(),
        };
      }
      if (p) commit.files.add(path.basename(p));
    }
  }
  const out = Object.values(groups).map((grp) => {
    const commits = Object.values(grp.commits).sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    for (const c of commits) c.files = Array.from(c.files).sort();
    return {
      remote: grp.remote, name: grp.name, root: grp.root, branch: grp.branch, head_short: grp.head_short,
      files: Array.from(grp.files).sort(), commits,
    };
  });
  out.sort((a, b) => b.commits.length - a.commits.length || String(a.name || "").localeCompare(String(b.name || "")));
  return out;
}

function buildSession(cid, threshold) {
  threshold = threshold || 0;
  if (!fs.existsSync(DB_PATH)) return { empty: true, conversation_id: cid };
  const store = new EventStore(DB_PATH);
  const events = store.eventsFor(cid);
  if (!events.length) return { empty: true, conversation_id: cid };
  const timeline = [];
  const toolPositions = [];
  const reposTouched = {};
  function recordRepos(gits) {
    for (const g of gits) {
      if (g.resolved && g.root) {
        reposTouched[g.root] = {
          name: g.name, root: g.root, branch: g.branch, head_short: g.head_short, remote: g.remote,
        };
      }
    }
  }
  for (const r of events) {
    const ev = rec.eventName(r);
    const kind = TIMELINE_KINDS[ev];
    if (!kind) continue;
    const entry = { event: ev, kind, ts_iso: r.ts_iso || "", text: rec.snippet(r) || "", original: trimForViewer(r) };
    if (kind === "tool") {
      entry.tool_name = r.tool_name || "";
      entry.candidate_paths = paths.pathsTouched(r);
      entry.heuristic_edit = FILE_CHANGE_TOOLS.has(r.tool_name);
      entry.file_edit = null;
      entry.source = "heuristic";
      entry.git = [];
      entry._tuid = r.tool_use_id;
      toolPositions.push(timeline.length);
    }
    timeline.push(entry);
  }
  const repoCache = {};
  const fileCache = {};
  for (const pos of toolPositions) {
    const entry = timeline[pos];
    if (!entry.heuristic_edit || (entry.git && entry.git.length)) continue;
    const gits = [];
    for (const p of entry.candidate_paths) {
      if (!fileCache[p]) fileCache[p] = gitmeta.fileInfo(p, repoCache);
      gits.push(fileCache[p]);
    }
    entry.git = gits;
    recordRepos(gits);
  }
  const preHashes = {};
  const postHashes = {};
  for (const r of events) {
    const tuid = r.tool_use_id;
    const ph = r.path_hashes;
    if (!tuid || !ph || typeof ph !== "object") continue;
    const ev = rec.eventName(r);
    if (ev === "preToolUse") preHashes[tuid] = ph;
    else if (ev === "postToolUse" || ev === "postToolUseFailure") {
      postHashes[tuid] = Object.assign(postHashes[tuid] || {}, ph);
    }
  }
  for (const pos of toolPositions) {
    const entry = timeline[pos];
    const capable = Boolean(entry.heuristic_edit);
    const resolved = (entry.git || []).filter((g) => g.resolved);
    const tuid = entry._tuid;
    const pre = preHashes[tuid] || {};
    const post = postHashes[tuid] || {};
    let compared = false;
    const changedPaths = [];
    for (const a of new Set(entry.candidate_paths || [])) {
      if (a in pre && a in post) {
        compared = true;
        if (pre[a] !== post[a]) {
          const kind3 = pre[a] == null ? "created" : post[a] == null ? "deleted" : "modified";
          changedPaths.push([path.basename(a), kind3]);
        }
      }
    }
    const changed = capable && changedPaths.length > 0;
    let changedStatus = "unknown";
    if (!capable) changedStatus = "skipped";
    else if (changed) changedStatus = "pass";
    else if (compared) changedStatus = "fail";
    let changeEvidence = null;
    if (changedPaths.length) {
      changeEvidence = "sha256 pre≠post: " + changedPaths.map(([n, k]) => n + " (" + k + ")").join(", ");
    } else if (compared) changeEvidence = "sha256 pre=post — bytes identical";
    else if (capable) changeEvidence = "no pre/post fingerprint captured for this call";
    entry.file_change = {
      capability: { status: capable ? "pass" : "fail", p_edit: null, threshold, source: "heuristic fallback" },
      git: { status: capable ? (resolved.length ? "pass" : "fail") : "skipped", resolved: resolved.length, candidates: (entry.candidate_paths || []).length },
      changed: { status: changedStatus, asserted: changed, compared, evidence: changeEvidence },
    };
  }
  const gitPairs = [];
  for (const pos of toolPositions) {
    const entry = timeline[pos];
    const gits = entry.git || [];
    const paths = entry.candidate_paths || [];
    gits.forEach((g, i) => gitPairs.push([(g && g.path) || paths[i] || null, g]));
  }
  return {
    conversation_id: cid, threshold, nli_available: false, git_available: true,
    tool_calls: toolPositions.length,
    flagged: toolPositions.filter((p) => timeline[p].heuristic_edit).length,
    repos_touched: Object.values(reposTouched),
    git_remotes: remotesFromCoords(gitPairs),
    timeline, event_total: events.length,
  };
}

module.exports = { buildPulse, buildSession, DB_PATH };
