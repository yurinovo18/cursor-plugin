"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventStore, defaultDbPath } = require("../local_storage/db");
const { buildBundle, writeBundleTgz } = require("./session_bundle");
const { publishBundle } = require("./publish");
const session = require("../viewer/session");

function exportSession(cid, opts) {
  opts = opts || {};
  const dbPath = process.env.MONITORING_DB || defaultDbPath();
  const store = new EventStore(dbPath);
  const bundle = buildBundle(cid, {
    threshold: opts.threshold,
    sessionBuilder: session.buildSession,
    eventStore: store,
  });
  if (bundle.error) return bundle;
  const tgz = path.join(os.tmpdir(), "session-" + String(cid).slice(0, 8) + "-" + Date.now() + ".tgz");
  const [outPath, manifest] = writeBundleTgz(bundle, tgz);
  const result = {
    conversation_id: cid,
    manifest,
    bundle_path: outPath,
    commit_tags: manifest.commit_tags,
  };
  if (opts.publish) {
    result.publish = publishBundle(outPath, manifest, { repo: opts.repo, dryRun: opts.dryRun });
    if (!result.publish.ok) result.error = result.publish.error;
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const cid = args.find((a) => !a.startsWith("-"));
  if (!cid) {
    console.error("Usage: node export_session.js <conversation_id> [--publish] [--dry-run]");
    process.exit(2);
  }
  const out = exportSession(cid, {
    publish: args.includes("--publish"),
    dryRun: args.includes("--dry-run"),
  });
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.error ? 1 : 0);
}

if (require.main === module) main();

module.exports = { exportSession };
