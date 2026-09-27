"use strict";

const gitmeta = require("./gitmeta");
const { WatchedGit } = require("../local_storage/watched_git");
const { Handler } = require("../hooks/runtime");

class GitCoordinateHandler extends Handler {
  constructor(opts) {
    super();
    opts = opts || {};
    this._fileInfo = opts.fileInfo || gitmeta.fileInfo;
    this._watched = opts.watched || null;
  }

  _getWatched() {
    if (!this._watched) this._watched = new WatchedGit();
    return this._watched;
  }

  handle(record, ctx) {
    try {
      const changed = record.changed_paths;
      if (!Array.isArray(changed) || !changed.length) return null;
      const cache = {};
      const coords = [];
      for (const p of changed) {
        coords.push(this._fileInfo(p, cache));
      }
      record.affected_git = coords;
      const cid = record.conversation_id || record.session_id || "";
      const watched = this._getWatched();
      for (const g of coords) {
        if (g && g.resolved && g.root && g.head) watched.noteRepo(g, cid);
      }
    } catch (exc) {
      ctx.warn("git coordinate bind failed: " + exc);
    }
    return null;
  }
}

module.exports = { GitCoordinateHandler };
