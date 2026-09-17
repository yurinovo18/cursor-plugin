"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CACHE = new Map();

function sha256Bytes(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256File(filePath, useCache = true) {
  let ap;
  let st;
  try {
    ap = path.resolve(filePath);
    st = fs.statSync(ap);
  } catch {
    return null;
  }
  const key = ap + "\0" + st.mtimeMs;
  if (useCache && CACHE.has(key)) return CACHE.get(key);
  let digest;
  try {
    digest = sha256Bytes(fs.readFileSync(ap));
  } catch {
    return null;
  }
  if (useCache) CACHE.set(key, digest);
  return digest;
}

module.exports = { sha256Bytes, sha256File };
