"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { GitCoordinateHandler } = require("./bind");
const { WatchedGit } = require("../local_storage/watched_git");

function warnCtx() {
  return { warn() {} };
}

test("skips git finder when content SHA did not change", () => {
  const noted = [];
  const h = new GitCoordinateHandler({
    fileInfo: () => {
      throw new Error("git finder must not run");
    },
    watched: { noteRepo: (info, cid) => noted.push({ info, cid }) },
  });
  const record = { event: "postToolUse", changed_paths: [], conversation_id: "sess-1" };
  h.handle(record, warnCtx());
  assert.equal(record.affected_git, undefined);
  assert.equal(noted.length, 0);
});

test("on content SHA change, stamps affected_git and watches that .git", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-bind-"));
  const watched = new WatchedGit(path.join(dir, "watched.json"), {
    head: () => "aaa111",
  });
  const h = new GitCoordinateHandler({
    fileInfo: (p) => ({
      resolved: true,
      path: p,
      root: "/work",
      git_dir: "/work/.git",
      head: "aaa111",
      branch: "main",
      remote: "git@example/work.git",
      last_commit: { sha: "aaa111", subject: "prior" },
    }),
    watched,
  });
  const record = {
    event: "postToolUse",
    conversation_id: "sess-1",
    changed_paths: ["/work/src/a.js"],
  };
  h.handle(record, warnCtx());
  assert.equal(record.affected_git.length, 1);
  assert.equal(record.affected_git[0].root, "/work");
  assert.equal(record.affected_git[0].head, "aaa111");
  assert.equal(record.affected_git[0].git_dir, "/work/.git");
  assert.deepEqual(watched.repos(), ["/work"]);
  assert.equal(watched.data.repos["/work"].logged_sha, "aaa111");
  assert.equal(watched.data.repos["/work"].git_dir, "/work/.git");
  assert.deepEqual(watched.cidsFor("/work"), ["sess-1"]);
});
