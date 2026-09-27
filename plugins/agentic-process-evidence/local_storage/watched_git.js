"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { defaultDbPath } = require("../paths");
const gitmeta = require("../git_finder/gitmeta");

function defaultWatchedPath() {
  if (process.env.WATCHED_GIT) return path.resolve(process.env.WATCHED_GIT);
  return defaultDbPath() + ".watched_git.json";
}

function gitHead(root) {
  try {
    const out = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 });
    if (out.status !== 0) return null;
    return (out.stdout || "").trim() || null;
  } catch {
    return null;
  }
}

function emptyData() {
  return { repos: {} };
}

class WatchedGit {
  constructor(filePath, opts) {
    opts = opts || {};
    this.path = filePath || defaultWatchedPath();
    this._repoRoot = opts.repoRoot || gitmeta.repoRoot;
    this._head = opts.head || gitHead;
    this.data = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, "utf8"));
      if (raw && typeof raw === "object") {
        raw.repos = raw.repos || {};
        return raw;
      }
    } catch {}
    return emptyData();
  }

  _save() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    fs.renameSync(tmp, this.path);
  }

  note(record) {
    if (!record || !Array.isArray(record.affected_git)) return;
    const cid = record.conversation_id || record.session_id || "";
    for (const g of record.affected_git) {
      this.noteRepo(g, cid);
    }
  }

  noteRepo(info, cid) {
    if (!info || !info.root || !info.head) return;
    const root = info.root;
    const gitDir = info.git_dir || path.join(root, ".git");
    const repo = this.data.repos[root] || {
      root,
      git_dir: gitDir,
      logged_sha: info.head,
      remote: info.remote || null,
      branch: info.branch || null,
      files: [],
      cids: [],
    };
    repo.git_dir = gitDir;
    repo.remote = info.remote || repo.remote || null;
    repo.branch = info.branch || repo.branch || null;
    if (!repo.logged_sha) repo.logged_sha = info.head;
    const filePath = info.path;
    if (filePath && repo.files.indexOf(filePath) === -1) repo.files.push(filePath);
    if (cid && cid !== "unknown" && repo.cids.indexOf(cid) === -1) repo.cids.push(cid);
    this.data.repos[root] = repo;
    this._save();
  }

  files() {
    const out = [];
    for (const root of this.repos()) {
      const repo = this.data.repos[root];
      for (const p of repo.files || []) {
        out.push({ path: p, root, git_dir: repo.git_dir, logged_sha: repo.logged_sha });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  repos() {
    return Object.keys(this.data.repos).sort();
  }

  cidsFor(root) {
    const repo = this.data.repos[root];
    return repo ? repo.cids.slice() : [];
  }

  detectCommits(opts) {
    opts = opts || {};
    const found = [];
    for (const root of this.repos()) {
      const repo = this.data.repos[root];
      const sha = this._head(root);
      if (!sha) continue;
      const prev = repo.logged_sha;
      if (!prev) {
        repo.logged_sha = sha;
        continue;
      }
      if (prev === sha) continue;
      found.push({
        root,
        git_dir: repo.git_dir,
        sha,
        previous: prev,
        files: (repo.files || []).slice(),
        cids: (repo.cids || []).slice(),
      });
      repo.logged_sha = sha;
    }
    if (opts.persist !== false) this._save();
    return found;
  }

  ack(commits, opts) {
    opts = opts || {};
    for (const commit of commits || []) {
      const repo = this.data.repos[commit.root];
      if (!repo) continue;
      if (opts.revert) {
        if (commit.previous) repo.logged_sha = commit.previous;
        continue;
      }
      if (commit.sha) repo.logged_sha = commit.sha;
      repo.files = [];
    }
    this._save();
  }
}

module.exports = { WatchedGit, defaultWatchedPath };
