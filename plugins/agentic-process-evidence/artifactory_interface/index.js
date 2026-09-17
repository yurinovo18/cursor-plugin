"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { sh, resolveServerId, withServer } = require("./jf");

const DEFAULT_REPO = process.env.SESSION_AUDIT_REPO || "agentic-policies";

function indexPathForSha(sha, repo) {
  return (repo || DEFAULT_REPO) + "/sessions/index/commits/" + String(sha || "").slice(0, 12) + ".json";
}

function sessionNameFromManifest(manifest) {
  const prompt = (manifest.first_prompt || "").trim();
  if (prompt) {
    const one = prompt.split(/\s+/).join(" ");
    return one.slice(0, 80) + (one.length > 80 ? "…" : "");
  }
  const cid = String(manifest.conversation_id || "").slice(0, 8);
  for (const tag of manifest.commit_tags || []) {
    const subject = (tag.subject || "").trim();
    if (subject) return cid + " — " + subject.slice(0, 60) + (subject.length > 60 ? "…" : "");
  }
  return cid || null;
}

function indexEntryFromManifest(manifest, publishResult) {
  const cid = manifest.conversation_id;
  const artifact = (publishResult || {}).target;
  const built = manifest.built_at;
  const summary = manifest.policy_summary || {};
  const breached = Object.keys(summary.by_policy || {})
    .filter((n) => Number(((summary.by_policy || {})[n] || {}).matches || 0) > 0)
    .sort();
  const entriesBySha = {};
  for (const tag of manifest.commit_tags || []) {
    const sha = tag.sha;
    if (!sha) continue;
    const short = tag.short || sha.slice(0, 12);
    if (!entriesBySha[sha]) entriesBySha[sha] = { sha, short, sessions: [] };
    entriesBySha[sha].sessions.push({
      conversation_id: cid, artifact, built_at: built,
      session_name: sessionNameFromManifest(manifest),
      first_prompt: manifest.first_prompt, role: tag.role,
      repo_name: tag.repo_name, repo_root: tag.repo_root, remote: tag.remote, branch: tag.branch,
      files: tag.files || [],
      policy_any_breach: Boolean(summary.any_breach),
      policy_breach_count: Number(summary.breach_count || 0),
      policies_breached: breached, subject: tag.subject,
    });
  }
  return entriesBySha;
}

function mergeIndex(existing, newSessions) {
  const byCid = {};
  for (const s of existing.sessions || []) byCid[s.conversation_id] = s;
  for (const s of newSessions || []) byCid[s.conversation_id] = s;
  existing.sessions = Object.values(byCid).sort((a, b) => String(b.built_at || "").localeCompare(String(a.built_at || "")));
  return existing;
}

function publishCommitIndexes(entriesBySha, opts) {
  opts = opts || {};
  const server = opts.server != null ? opts.server : resolveServerId();
  const repo = opts.repo || DEFAULT_REPO;
  const out = [];
  for (const [sha, payload] of Object.entries(entriesBySha)) {
    const remotePath = indexPathForSha(sha, repo);
    let existing = { sha, short: payload.short, sessions: [] };
    const tmp = path.join(os.tmpdir(), "idx-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".json");
    if (!opts.dryRun) {
      const res = sh(withServer(["jf", "rt", "download", remotePath, tmp, "--flat=true"], server));
      if (res.status === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size) {
        try { existing = JSON.parse(fs.readFileSync(tmp, "utf8")); } catch {}
      }
      try { fs.unlinkSync(tmp); } catch {}
    }
    const merged = mergeIndex(existing, payload.sessions || []);
    if (opts.dryRun) {
      out.push({ path: remotePath, sessions: (merged.sessions || []).length, dry_run: true });
      continue;
    }
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    const res = sh(withServer(["jf", "rt", "upload", tmp, remotePath, "--flat=true"], server));
    try { fs.unlinkSync(tmp); } catch {}
    out.push({
      path: remotePath, ok: res.status === 0, sessions: (merged.sessions || []).length,
      error: res.status ? (res.stderr || res.stdout || "").trim() : null,
    });
  }
  return out;
}

module.exports = { indexEntryFromManifest, publishCommitIndexes, indexPathForSha };
