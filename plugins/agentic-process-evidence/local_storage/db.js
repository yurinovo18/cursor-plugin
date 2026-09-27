"use strict";

const fs = require("fs");
const path = require("path");
const { Handler } = require("../hooks/runtime");
const { defaultDbPath } = require("../paths");
const { WatchedGit } = require("./watched_git");

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(lockPath, fn) {
  const start = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        return fn();
      } finally {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lockPath); } catch {}
      }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - start > 30000) throw e;
      sleep(20);
    }
  }
}

function emptyIndex() {
  return { next_id: 1, count: 0, conversations: {} };
}

class EventStore {
  constructor(filePath) {
    this.path = filePath || defaultDbPath();
    this.indexPath = this.path + ".idx.json";
    this.lockPath = this.path + ".lock";
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (!fs.existsSync(this.path)) fs.writeFileSync(this.path, "");
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, JSON.stringify(emptyIndex()) + "\n");
    }
  }

  close() {}

  _loadIndex() {
    try {
      return JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
    } catch {
      return emptyIndex();
    }
  }

  _saveIndex(idx) {
    const tmp = this.indexPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(idx) + "\n");
    fs.renameSync(tmp, this.indexPath);
  }

  append(record) {
    const ti = record.tool_input && typeof record.tool_input === "object" ? record.tool_input : {};
    withLock(this.lockPath, () => {
      const idx = this._loadIndex();
      const id = idx.next_id++;
      const row = Object.assign({}, record, { _id: id });
      fs.appendFileSync(this.path, JSON.stringify(row) + "\n");
      idx.count += 1;
      const cid = record.conversation_id || record.session_id || "";
      if (cid) {
        const bucket = idx.conversations[cid] || { n: 0, first_ts: row.ts, last_ts: row.ts, max_id: id };
        bucket.n += 1;
        bucket.last_ts = row.ts;
        bucket.max_id = id;
        if (bucket.first_ts == null) bucket.first_ts = row.ts;
        idx.conversations[cid] = bucket;
      }
      this._saveIndex(idx);
    });
  }

  _iter() {
    let raw = "";
    try {
      raw = fs.readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    out.sort((a, b) => (a.ts || 0) - (b.ts || 0) || (a._id || 0) - (b._id || 0));
    return out;
  }

  iterEvents() {
    return this._iter();
  }

  eventsFor(cid) {
    return this._iter().filter((r) => (r.conversation_id || r.session_id) === cid);
  }

  conversations() {
    const idx = this._loadIndex();
    return Object.keys(idx.conversations).map((cid) => {
      const b = idx.conversations[cid];
      return { cid, n: b.n, first_ts: b.first_ts, last_ts: b.last_ts };
    }).sort((a, b) => (a.first_ts || 0) - (b.first_ts || 0));
  }

  conversationStats() {
    const idx = this._loadIndex();
    return Object.keys(idx.conversations).map((cid) => {
      const b = idx.conversations[cid];
      return { cid, n: b.n, max_id: b.max_id || 0, last_ts: b.last_ts };
    });
  }

  maxId() {
    return this._loadIndex().next_id - 1;
  }

  maxIdFor(cid) {
    const b = this._loadIndex().conversations[cid];
    return b ? (b.max_id || 0) : 0;
  }

  lastTsFor(cid) {
    const b = this._loadIndex().conversations[cid];
    return b ? b.last_ts : null;
  }

  count() {
    return this._loadIndex().count;
  }
}

class StoreHandler extends Handler {
  constructor(dbPath) {
    super();
    this.dbPath = dbPath || defaultDbPath();
    this._store = null;
  }
  _get() {
    if (!this._store) this._store = new EventStore(this.dbPath);
    return this._store;
  }
  handle(record, ctx) {
    try {
      this._get().append(record);
    } catch (exc) {
      ctx.warn("event store append failed: " + exc);
    }
    return null;
  }
}

module.exports = { EventStore, StoreHandler, defaultDbPath, WatchedGit };
