"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { WatchedGit } = require("./watched_git");

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watched-git-"));
  return path.join(dir, "watched.json");
}

test("note without affected_git does not watch a repo", () => {
  const store = new WatchedGit(tmpStore(), { repoRoot: () => "/work" });
  store.note({
    conversation_id: "sess-1",
    path_hashes: { "/work/src/a.js": "aaa" },
  });
  assert.deepEqual(store.repos(), []);
});

test("noteRepo stores the logged HEAD and .git path", () => {
  const store = new WatchedGit(tmpStore(), { head: () => "aaa111" });
  store.noteRepo({
    root: "/work",
    git_dir: "/work/.git",
    head: "aaa111",
    path: "/work/src/a.js",
    remote: "git@example/work.git",
    branch: "main",
  }, "sess-1");
  assert.deepEqual(store.repos(), ["/work"]);
  const repo = store.data.repos["/work"];
  assert.equal(repo.logged_sha, "aaa111");
  assert.equal(repo.git_dir, "/work/.git");
  assert.deepEqual(repo.cids, ["sess-1"]);
  assert.deepEqual(repo.files, ["/work/src/a.js"]);
});

test("detectCommits fires when HEAD moves off the logged commit", () => {
  let head = "aaa111";
  const store = new WatchedGit(tmpStore(), { head: () => head });
  store.noteRepo({
    root: "/work",
    git_dir: "/work/.git",
    head: "aaa111",
    path: "/work/src/a.js",
  }, "sess-1");
  assert.deepEqual(store.detectCommits(), []);
  head = "bbb222";
  const found = store.detectCommits();
  assert.equal(found.length, 1);
  assert.equal(found[0].root, "/work");
  assert.equal(found[0].previous, "aaa111");
  assert.equal(found[0].sha, "bbb222");
  assert.deepEqual(found[0].cids, ["sess-1"]);
  assert.deepEqual(found[0].files, ["/work/src/a.js"]);
  assert.equal(store.data.repos["/work"].logged_sha, "bbb222");
});

test("ack after a publish clears files but keeps the session so a later HEAD move still fires", () => {
  let head = "aaa111";
  const store = new WatchedGit(tmpStore(), { head: () => head });
  store.noteRepo({
    root: "/work",
    git_dir: "/work/.git",
    head: "aaa111",
    path: "/work/src/a.js",
  }, "sess-1");
  head = "bbb222";
  const first = store.detectCommits();
  store.ack(first);
  const repo = store.data.repos["/work"];
  assert.equal(repo.logged_sha, "bbb222");
  assert.deepEqual(repo.files, []);
  assert.deepEqual(repo.cids, ["sess-1"]);

  store.noteRepo({
    root: "/work",
    git_dir: "/work/.git",
    head: "bbb222",
    path: "/work/src/b.js",
  }, "sess-1");
  assert.equal(store.data.repos["/work"].logged_sha, "bbb222");
  assert.deepEqual(store.data.repos["/work"].files, ["/work/src/b.js"]);

  head = "ccc333";
  const second = store.detectCommits();
  assert.equal(second.length, 1);
  assert.equal(second[0].previous, "bbb222");
  assert.equal(second[0].sha, "ccc333");
  assert.deepEqual(second[0].cids, ["sess-1"]);
  assert.deepEqual(second[0].files, ["/work/src/b.js"]);
});

test("ack revert restores logged_sha when publish failed so the same commit can retry", () => {
  let head = "bbb222";
  const store = new WatchedGit(tmpStore(), { head: () => head });
  store.noteRepo({
    root: "/work",
    git_dir: "/work/.git",
    head: "aaa111",
    path: "/work/src/a.js",
  }, "sess-1");
  const found = store.detectCommits();
  store.ack(found, { revert: true });
  assert.equal(store.data.repos["/work"].logged_sha, "aaa111");
  assert.deepEqual(store.data.repos["/work"].files, ["/work/src/a.js"]);
  assert.deepEqual(store.detectCommits().map((c) => c.sha), ["bbb222"]);
});

test("persists and reloads the repo collection", () => {
  const filePath = tmpStore();
  const a = new WatchedGit(filePath, { head: () => "aaa111" });
  a.noteRepo({ root: "/work", git_dir: "/work/.git", head: "aaa111", path: "/work/x.txt" }, "sess-1");
  const b = new WatchedGit(filePath, { head: () => "aaa111" });
  assert.deepEqual(b.repos(), ["/work"]);
  assert.equal(b.data.repos["/work"].logged_sha, "aaa111");
});
