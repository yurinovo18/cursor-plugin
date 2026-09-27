"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { sh, resolveServerId, resolveArtifactoryUrl, withServer } = require("./jf");

const DEFAULT_REPO = process.env.SESSION_AUDIT_REPO || "agentic-policies";
const PROP_BAD = /[;=\r\n]+/g;

function cleanProp(value) {
  if (value == null) return "";
  return String(value).replace(PROP_BAD, " ").trim();
}

function slug(name) {
  const s = String(name || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "").toLowerCase();
  return (s || "unnamed").slice(0, 64);
}

function propsCliString(props) {
  const parts = [];
  for (const [k, v] of Object.entries(props)) {
    const key = cleanProp(k).replace(/ /g, "_");
    const val = cleanProp(v);
    if (!key || val === "") continue;
    parts.push(key + "=" + val);
  }
  return parts.join(";");
}

function artifactoryTarget(manifest, repo) {
  repo = repo || DEFAULT_REPO;
  const cid = manifest.conversation_id || "unknown";
  let built = String(manifest.built_at || "").replace(/[:\-]/g, "");
  built = built.slice(0, 15) || String(Math.floor(Date.now() / 1000));
  const short = cid ? cid.split("-")[0] : "session";
  return repo + "/sessions/" + short + "/" + cid + "/session-bundle-" + built + ".tgz";
}

function artifactoryProperties(manifest) {
  const summary = manifest.policy_summary || {};
  const byPolicy = summary.by_policy || {};
  const breached = Object.keys(byPolicy).filter((n) => Number((byPolicy[n] || {}).matches || 0) > 0).sort();
  const props = {
    "apptrust.schema": manifest.schema || "",
    "apptrust.kind": manifest.kind || "generic",
    "session.conversation_id": manifest.conversation_id || "",
    "policy.any_breach": summary.any_breach ? "true" : "false",
    "policy.breach_count": String(Number(summary.breach_count || 0)),
    "policy.breached_count": String(breached.length),
  };
  if (breached.length) props["policy.breached"] = breached.slice(0, 32).map(cleanProp).join(",");
  for (const name of Object.keys(byPolicy).sort()) {
    const stats = byPolicy[name] || {};
    const matches = Number(stats.matches || 0);
    if (matches <= 0) continue;
    const s = slug(name);
    props["policy." + s + ".breach"] = "true";
    props["policy." + s + ".matches"] = String(matches);
    props["policy." + s + ".max_entailment"] = Number(stats.max_entailment || 0).toFixed(4);
  }
  const tags = manifest.commit_tags || [];
  let shas = Array.from(manifest.commit_shas || []);
  if (!shas.length) shas = Array.from(new Set(tags.map((t) => t.sha).filter(Boolean))).sort();
  const repos = Array.from(new Set(tags.map((t) => t.repo_name || t.remote).filter(Boolean))).sort();
  const remotes = Array.from(new Set(tags.map((t) => t.remote).filter(Boolean))).sort();
  const branches = Array.from(new Set(tags.map((t) => t.branch).filter(Boolean))).sort();
  const heads = tags.filter((t) => t.role === "branch_head" && t.sha).map((t) => t.sha);
  if (repos.length) {
    props["git.repo"] = repos.slice(0, 16).map(cleanProp).join(",");
    props["git.repo_count"] = String(repos.length);
  }
  if (remotes.length) props["git.remote"] = remotes.slice(0, 16).map(cleanProp).join(",");
  if (branches.length) {
    props["git.branch"] = branches.slice(0, 16).map(cleanProp).join(",");
    props["git.branch_count"] = String(branches.length);
  }
  if (shas.length) {
    props["git.commit"] = shas.slice(0, 32).map(cleanProp).join(",");
    props["git.commit_count"] = String(shas.length);
  }
  if (heads.length) props["git.head"] = heads.slice(0, 8).map(cleanProp).join(",");
  const out = {};
  for (const [k, v] of Object.entries(props)) if (v !== "" && v != null) out[k] = v;
  return out;
}

function publishBundle(tgzPath, manifest, opts) {
  opts = opts || {};
  if (!fs.existsSync(tgzPath)) return { ok: false, error: "bundle not found: " + tgzPath };
  const server = opts.server != null ? opts.server : resolveServerId();
  const target = artifactoryTarget(manifest, opts.repo);
  const props = artifactoryProperties(manifest);
  const propsCli = propsCliString(props);
  if (opts.dryRun) {
    return { ok: true, dry_run: true, target, properties: props, properties_cli: propsCli, local: tgzPath, server };
  }
  const uploadCmd = withServer(["jf", "rt", "upload", tgzPath, target, "--flat=true"], server);
  if (propsCli) uploadCmd.push("--target-props=" + propsCli);
  const res = sh(uploadCmd);
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "upload failed").trim(), target, properties: props, server };
  }
  let propsResult = { ok: true, applied: Boolean(propsCli) };
  if (propsCli) {
    const propRes = sh(withServer(["jf", "rt", "set-props", target, propsCli], server));
    if (propRes.status !== 0) {
      propsResult = { ok: false, error: (propRes.stderr || propRes.stdout || "set-props failed").trim() };
    }
  }
  let indexResults = [];
  try {
    const { indexEntryFromManifest, publishCommitIndexes } = require("./index");
    const entries = indexEntryFromManifest(manifest, { target });
    indexResults = publishCommitIndexes(entries, { repo: opts.repo || DEFAULT_REPO, server, dryRun: opts.dryRun });
  } catch (exc) {
    indexResults = [{ error: String(exc) }];
  }
  const base = resolveArtifactoryUrl(server);
  const url = (base ? base + "/" : "") + target;
  return {
    ok: true, target, url, server, properties: props, properties_set: propsResult,
    bundle_sha256: manifest.bundle_sha256, commit_index: indexResults,
  };
}

module.exports = { publishBundle, artifactoryTarget, artifactoryProperties, DEFAULT_REPO, get SERVER() { return resolveServerId(); } };
