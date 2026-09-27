"use strict";

const fs = require("fs");
const path = require("path");
const rec = require("../local_storage/session_objects_logic/record");
const paths = require("./path_extractor");
const { sha256File } = require("./hashing");
const { Handler } = require("../hooks/runtime");
const { defaultDbPath } = require("../paths");

const CAPTURE_EVENTS = new Set(["preToolUse", "postToolUse", "postToolUseFailure"]);
const PRE_EVENTS = new Set(["preToolUse"]);
const POST_EVENTS = new Set(["postToolUse", "postToolUseFailure"]);
const PRE_TTL_SEC = 3600;

function defaultPreHashPath() {
  return defaultDbPath() + ".pre_hashes.json";
}

function diffHashes(pre, post) {
  const a = pre || {};
  const b = post || {};
  const keys = new Set(Object.keys(a).concat(Object.keys(b)));
  const changed = [];
  for (const k of keys) {
    if (a[k] !== b[k]) changed.push(k);
  }
  return changed;
}

function loadPre(storePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function savePre(storePath, data) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = storePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data) + "\n");
  fs.renameSync(tmp, storePath);
}

function prunePre(data, now) {
  const cutoff = now - PRE_TTL_SEC;
  for (const id of Object.keys(data)) {
    const row = data[id];
    if (!row || typeof row.ts !== "number" || row.ts < cutoff) delete data[id];
  }
  return data;
}

class FileHashHandler extends Handler {
  constructor(opts) {
    super();
    opts = opts || {};
    this.storePath = opts.storePath || defaultPreHashPath();
    this.hashFn = opts.hashFn || ((p) => sha256File(p, false));
  }

  handle(record, ctx) {
    try {
      const event = rec.eventName(record);
      if (!CAPTURE_EVENTS.has(event)) return null;
      const cmd = rec.commandOf(record);
      if (cmd) {
        const extracted = paths.archiveExtractTargets(cmd, rec.eventCwd(record));
        if (extracted.length) record._extract_targets = extracted;
      }
      const hashes = {};
      for (const ap of paths.pathsTouched(record)) {
        if (!(ap in hashes)) hashes[ap] = this.hashFn(ap);
      }
      if (Object.keys(hashes).length) record.path_hashes = hashes;
      const tuid = record.tool_use_id;
      if (!tuid) return null;
      if (PRE_EVENTS.has(event)) {
        const data = prunePre(loadPre(this.storePath), record.ts || Date.now() / 1000);
        data[tuid] = { hashes: record.path_hashes || {}, ts: record.ts || Date.now() / 1000 };
        savePre(this.storePath, data);
        return null;
      }
      if (POST_EVENTS.has(event)) {
        const data = loadPre(this.storePath);
        const prior = data[tuid];
        const preHashes = prior && prior.hashes ? prior.hashes : null;
        if (preHashes) {
          record.changed_paths = diffHashes(preHashes, record.path_hashes || {});
          record.content_changed = record.changed_paths.length > 0;
        }
        if (data[tuid]) {
          delete data[tuid];
          savePre(this.storePath, data);
        }
      }
    } catch (exc) {
      ctx.warn("file hash capture failed: " + exc);
    }
    return null;
  }
}

module.exports = { FileHashHandler, diffHashes, defaultPreHashPath };
