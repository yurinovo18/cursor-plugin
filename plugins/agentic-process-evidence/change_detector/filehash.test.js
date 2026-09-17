"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { FileHashHandler, diffHashes } = require("./filehash");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "filehash-"));
}

function warnCtx() {
  return { warn() {} };
}

test("diffHashes reports only paths whose content SHA changed", () => {
  assert.deepEqual(
    diffHashes({ "/a": "aaa", "/b": "bbb" }, { "/a": "aaa", "/b": "BBB" }).sort(),
    ["/b"]
  );
  assert.deepEqual(diffHashes({ "/a": "aaa" }, { "/a": "aaa" }), []);
  assert.deepEqual(diffHashes({ "/a": null }, { "/a": "new" }), ["/a"]);
  assert.deepEqual(diffHashes({ "/a": "old" }, { "/a": null }), ["/a"]);
  assert.deepEqual(diffHashes({ "/a": null }, { "/a": null }), []);
});

test("postToolUse with a different content SHA sets changed_paths", () => {
  const dir = tmp();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "before");
  const h = new FileHashHandler({ storePath: path.join(dir, "pre.json") });
  const pre = {
    event: "preToolUse",
    tool_use_id: "t1",
    tool_input: { file_path: file },
  };
  h.handle(pre, warnCtx());
  fs.writeFileSync(file, "after");
  const post = {
    event: "postToolUse",
    tool_use_id: "t1",
    tool_input: { file_path: file },
  };
  h.handle(post, warnCtx());
  assert.deepEqual(post.changed_paths, [path.resolve(file)]);
  assert.equal(post.content_changed, true);
  assert.ok(post.path_hashes[path.resolve(file)]);
  assert.notEqual(pre.path_hashes[path.resolve(file)], post.path_hashes[path.resolve(file)]);
});

test("postToolUse with the same content SHA does not mark a change", () => {
  const dir = tmp();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "same");
  const h = new FileHashHandler({ storePath: path.join(dir, "pre.json") });
  h.handle({
    event: "preToolUse",
    tool_use_id: "t2",
    tool_input: { file_path: file },
  }, warnCtx());
  const post = {
    event: "postToolUse",
    tool_use_id: "t2",
    tool_input: { file_path: file },
  };
  h.handle(post, warnCtx());
  assert.deepEqual(post.changed_paths, []);
  assert.equal(post.content_changed, false);
});
