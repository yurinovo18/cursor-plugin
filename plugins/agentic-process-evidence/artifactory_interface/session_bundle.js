"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { enrichCommitTags } = require("../git_finder/git_links");

const BUNDLE_SCHEMA = "apptrust.session-bundle/v1";
const BUNDLE_KIND = "generic";

function utcNowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function firstUserPrompt(events) {
  for (const row of events || []) {
    if (row.event !== "beforeSubmitPrompt") continue;
    const prompt = (row.prompt || "").trim();
    if (prompt) return prompt;
  }
  return null;
}

function buildBundle(cid, opts) {
  opts = opts || {};
  const sessionBuilder = opts.sessionBuilder;
  if (!sessionBuilder) throw new Error("sessionBuilder required");
  const editThr = opts.threshold != null ? Number(opts.threshold) : 0.5;
  const session = sessionBuilder(cid, editThr);
  if (session.empty) return { error: "session not found", conversation_id: cid };
  const events = opts.eventStore ? opts.eventStore.eventsFor(cid) : [];
  const commitTags = enrichCommitTags(session, events);
  const firstPrompt = firstUserPrompt(events);
  const manifest = {
    schema: BUNDLE_SCHEMA,
    kind: BUNDLE_KIND,
    conversation_id: cid,
    built_at: utcNowIso(),
    first_prompt: firstPrompt,
    thresholds: { file_edit: editThr, policy: 0 },
    commit_tags: commitTags,
    commit_shas: Array.from(new Set(commitTags.map((t) => t.sha).filter(Boolean))).sort(),
    policy_summary: { any_breach: false, breach_count: 0, breach_indices: [], by_policy: {}, scored_messages: 0 },
    stats: {
      tool_calls: session.tool_calls,
      flagged_edits: session.flagged,
      event_count: events.length,
      finding_count: 0,
    },
    files: ["manifest.json", "session.json", "events.jsonl", "findings.jsonl", "policy_scores.json"],
  };
  return {
    manifest,
    session,
    events,
    findings: [],
    policy_scores: { messages: [], aggregated: {} },
  };
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function writeBundleTgz(bundle, destPath) {
  const manifest = Object.assign({}, bundle.manifest);
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "session-bundle-"));
  try {
    writeJson(path.join(tmpdir, "session.json"), bundle.session);
    fs.writeFileSync(
      path.join(tmpdir, "events.jsonl"),
      (bundle.events || []).map((row) => JSON.stringify(row)).join("\n") + (bundle.events && bundle.events.length ? "\n" : "")
    );
    fs.writeFileSync(path.join(tmpdir, "findings.jsonl"), "");
    writeJson(path.join(tmpdir, "policy_scores.json"), bundle.policy_scores || {});
    const contentHashes = {};
    for (const name of ["session.json", "events.jsonl", "findings.jsonl", "policy_scores.json"]) {
      contentHashes[name] = sha256File(path.join(tmpdir, name));
    }
    manifest.content_hashes = contentHashes;
    writeJson(path.join(tmpdir, "manifest.json"), manifest);
    const out = destPath || path.join(os.tmpdir(), "session-bundle-" + Date.now() + ".tgz");
    const tar = spawnSync("tar", ["-czf", out, ...manifest.files], { cwd: tmpdir, encoding: "utf8" });
    if (tar.status !== 0) throw new Error(tar.stderr || "tar failed");
    manifest.bundle_sha256 = sha256File(out);
    return [out, manifest];
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}

module.exports = { BUNDLE_SCHEMA, buildBundle, writeBundleTgz };
