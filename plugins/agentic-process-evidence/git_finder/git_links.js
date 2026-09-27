"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function git(root, args) {
  try {
    const res = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 30000 });
    if (res.status !== 0) return null;
    return (res.stdout || "").trim();
  } catch {
    return null;
  }
}

function parseLogLine(line) {
  const parts = (line || "").split("|");
  if (parts.length < 2) return null;
  return {
    sha: parts[0],
    short: parts[1],
    subject: parts[2] || "",
    author: parts[3] || "",
    date: parts[4] || "",
  };
}

function sessionWindow(events) {
  const isos = (events || []).map((e) => e.ts_iso).filter(Boolean).sort();
  if (!isos.length) return [null, null];
  return [isos[0], isos[isos.length - 1]];
}

function changedFiles(session) {
  const files = new Set();
  for (const grp of session.git_remotes || []) {
    for (const f of grp.files || []) if (f) files.add(f);
  }
  for (const entry of session.timeline || []) {
    const fc = entry.file_change || {};
    if ((fc.changed || {}).status !== "pass") continue;
    for (const p of entry.candidate_paths || []) if (p) files.add(p);
  }
  return Array.from(files).sort();
}

function enrichCommitTags(session, events) {
  const cid = session.conversation_id;
  const tags = [];
  const seen = new Set();
  function add(tag) {
    const sha = tag.sha;
    if (!sha || seen.has(sha)) return;
    seen.add(sha);
    if (!tag.conversation_id) tag.conversation_id = cid;
    tags.push(tag);
  }
  for (const grp of session.git_remotes || []) {
    for (const c of grp.commits || []) {
      if (!c.sha) continue;
      add({
        sha: c.sha, short: c.short, remote: grp.remote, repo_name: grp.name,
        repo_root: grp.root, branch: grp.branch, head_short: grp.head_short,
        subject: c.subject, author: c.author, date: c.date, files: c.files || [],
        role: "last_touch",
      });
    }
  }
  const remotesByRoot = {};
  for (const grp of session.git_remotes || []) {
    if (grp && grp.root) remotesByRoot[grp.root] = grp;
  }
  for (const row of events || []) {
    if ((row.event || row.hook_event_name) !== "gitHeadChanged") continue;
    const ch = row.git_head_change || {};
    if (!ch.sha) continue;
    const grp = remotesByRoot[ch.root] || {};
    add({
      sha: ch.sha,
      short: ch.sha.slice(0, 12),
      remote: grp.remote,
      repo_name: grp.name,
      repo_root: ch.root,
      branch: grp.branch,
      files: (ch.files || []).map((f) => path.basename(f)).slice(0, 40),
      role: "session_authored",
    });
  }
  const [sinceIso] = sessionWindow(events);
  const changed = changedFiles(session);
  for (const grp of session.git_remotes || []) {
    const root = grp.root;
    if (!root || !fs.existsSync(path.join(root, ".git"))) continue;
    const branch = grp.branch || "HEAD";
    const head = git(root, ["rev-parse", "HEAD"]);
    if (head) {
      const short = git(root, ["rev-parse", "--short", "HEAD"]);
      add({
        sha: head, short, remote: grp.remote, repo_name: grp.name, repo_root: root,
        branch, head_short: short,
        subject: git(root, ["log", "-1", "--format=%s", head]),
        author: git(root, ["log", "-1", "--format=%an", head]),
        date: git(root, ["log", "-1", "--format=%ad", "--date=short", head]),
        files: changed.filter((f) => f.startsWith(root)).map((f) => path.basename(f)).slice(0, 40),
        role: "branch_head",
      });
    }
    if (sinceIso) {
      const fmt = "%H|%h|%s|%an|%ad";
      const log = git(root, ["log", "--since=" + sinceIso, "--format=" + fmt, "--date=short", branch]);
      if (log) {
        for (const line of log.split("\n")) {
          const row = parseLogLine(line);
          if (row) add(Object.assign(row, {
            remote: grp.remote, repo_name: grp.name, repo_root: root, branch, files: [], role: "session_window",
          }));
        }
      }
      for (const filePath of changed) {
        if (!filePath.startsWith(root)) continue;
        const rel = path.relative(root, filePath);
        const line = git(root, ["log", "--since=" + sinceIso, "-1", "--format=" + fmt, "--date=short", branch, "--", rel]);
        const row = line ? parseLogLine(line) : null;
        if (row) add(Object.assign(row, {
          remote: grp.remote, repo_name: grp.name, repo_root: root, branch,
          files: [path.basename(filePath)], role: "session_authored",
        }));
      }
    }
  }
  const roleRank = (r) => (r === "branch_head" ? 0 : r === "session_authored" ? 1 : 2);
  tags.sort((a, b) => roleRank(a.role) - roleRank(b.role) || String(b.date).localeCompare(String(a.date)) || String(b.sha).localeCompare(String(a.sha)));
  return tags;
}

module.exports = { enrichCommitTags };
