"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function run(args, cwd) {
  try {
    const out = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
    return out.status === 0 ? (out.stdout || "").trim() : null;
  } catch {
    return null;
  }
}

function repoRoot(filePath) {
  const d = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
    ? filePath
    : path.dirname(filePath);
  if (!d || !fs.existsSync(d)) return null;
  return run(["rev-parse", "--show-toplevel"], d);
}

function repoInfo(root) {
  const gitDir = run(["rev-parse", "--absolute-git-dir"], root);
  return {
    root,
    name: path.basename(root),
    git_dir: gitDir,
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"], root),
    head: run(["rev-parse", "HEAD"], root),
    head_short: run(["rev-parse", "--short", "HEAD"], root),
    remote: run(["config", "--get", "remote.origin.url"], root),
  };
}

function fileInfo(filePath, repoCache) {
  if (!filePath) return { resolved: false, reason: "no path" };
  const exists = fs.existsSync(filePath);
  const root = repoRoot(filePath);
  if (!root) {
    return {
      resolved: false,
      exists,
      reason: exists ? "not in a git repo" : "path not found",
      path: filePath,
    };
  }
  let info;
  if (repoCache && repoCache[root]) info = Object.assign({}, repoCache[root]);
  else {
    info = repoInfo(root);
    if (repoCache) repoCache[root] = info;
  }
  info = Object.assign({}, info);
  const rel = path.relative(root, filePath);
  info.path = filePath;
  info.rel_path = rel;
  info.exists = exists;
  info.tracked = run(["ls-files", "--error-unmatch", "--", rel], root) != null;
  info.dirty = Boolean(run(["status", "--porcelain", "--", rel], root));
  const log = run(["log", "-1", "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s", "--date=short", "--", rel], root);
  const parts = log ? log.split("\x1f") : [];
  info.last_commit = parts.length === 5
    ? { sha: parts[0], short: parts[1], author: parts[2], date: parts[3], subject: parts[4] }
    : null;
  info.resolved = true;
  return info;
}

module.exports = { fileInfo, repoRoot, repoInfo };
