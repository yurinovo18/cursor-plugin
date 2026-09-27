"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { detectNewCommits, conversationsForRepo, publishOnNewCommits, stampHeadOnLogs, tick } = require("./watch");

test("detectNewCommits reports a repo whose HEAD moved", () => {
  const heads = {
    "/repo-a": "aaa111",
    "/repo-b": "bbb222",
  };
  const found = detectNewCommits(
    ["/repo-a", "/repo-b"],
    { repos: { "/repo-a": { last_head: "aaa111" }, "/repo-b": { last_head: "old" } } },
    (root) => heads[root]
  );
  assert.deepEqual(found, [{ root: "/repo-b", sha: "bbb222", previous: "old" }]);
});

test("detectNewCommits skips first sight of a repo until HEAD changes later", () => {
  const state = { repos: {} };
  const first = detectNewCommits(["/repo"], state, () => "sha1");
  assert.deepEqual(first, []);
  assert.equal(state.repos["/repo"].last_head, "sha1");
  const second = detectNewCommits(["/repo"], state, () => "sha2");
  assert.deepEqual(second, [{ root: "/repo", sha: "sha2", previous: "sha1" }]);
});

test("conversationsForRepo matches affected_git roots", () => {
  const events = [
    { conversation_id: "keep", affected_git: [{ root: "/work", head: "aaa" }] },
    { conversation_id: "drop", affected_git: [{ root: "/other", head: "bbb" }] },
    { conversation_id: "keep", path_hashes: { "/work/app/file.js": "abc" } },
  ];
  const cids = conversationsForRepo(events, "/work");
  assert.deepEqual(Array.from(cids).sort(), ["keep"]);
});

test("stampHeadOnLogs appends the new commit onto each matching session", () => {
  const appended = [];
  stampHeadOnLogs(
    { append: (row) => appended.push(row) },
    [{ root: "/work", sha: "bbb222", previous: "aaa111", cids: ["sess-1", "sess-2"], files: ["/work/a.js"] }]
  );
  assert.equal(appended.length, 2);
  assert.equal(appended[0].conversation_id, "sess-1");
  assert.equal(appended[0].event, "gitHeadChanged");
  assert.equal(appended[0].git_head_change.sha, "bbb222");
  assert.equal(appended[0].git_head_change.previous, "aaa111");
  assert.equal(appended[0].affected_git[0].head, "bbb222");
  assert.equal(appended[1].conversation_id, "sess-2");
});

test("publishOnNewCommits exports matching sessions with publish true", () => {
  const published = [];
  const events = [
    { conversation_id: "sess-1", workspace_roots: ["/work"] },
    { conversation_id: "hook-probe", workspace_roots: ["/work"] },
  ];
  const report = publishOnNewCommits({
    commits: [{ root: "/work", sha: "deadbeef", previous: "cafe" }],
    events,
    exportSession: (cid, opts) => {
      published.push({ cid, opts });
      return { publish: { ok: true, target: "repo/sess.tgz" }, manifest: { commit_shas: ["deadbeef"] } };
    },
  });
  assert.equal(published.length, 1);
  assert.equal(published[0].cid, "sess-1");
  assert.equal(published[0].opts.publish, true);
  assert.equal(report.published[0].conversation_id, "sess-1");
  assert.equal(report.published[0].sha, "deadbeef");
});

test("tick stamps new HEAD on session logs then uploads all of them", () => {
  const appended = [];
  const published = [];
  const report = tick({
    store: {
      iterEvents: () => [{ conversation_id: "sess-1", affected_git: [{ root: "/work" }] }],
      append: (row) => appended.push(row),
    },
    watched: {
      detectCommits: () => [{
        root: "/work",
        sha: "bbb222",
        previous: "aaa111",
        cids: ["sess-1"],
        files: ["/work/a.js"],
      }],
      repos: () => ["/work"],
      files: () => [{ path: "/work/a.js" }],
    },
    exportSession: (cid, opts) => {
      published.push({ cid, opts });
      return { publish: { ok: true, target: "repo/sess.tgz" } };
    },
  });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].git_head_change.sha, "bbb222");
  assert.equal(published.length, 1);
  assert.equal(published[0].cid, "sess-1");
  assert.equal(published[0].opts.publish, true);
  assert.equal(report.published[0].conversation_id, "sess-1");
});

test("tick acks a successful publish so a second HEAD move in the same session still uploads", () => {
  const appended = [];
  const published = [];
  const acked = [];
  let n = 0;
  const watched = {
    detectCommits: () => {
      n += 1;
      if (n === 1) {
        return [{ root: "/work", sha: "bbb", previous: "aaa", cids: ["sess-1"], files: ["/work/a.js"] }];
      }
      return [{ root: "/work", sha: "ccc", previous: "bbb", cids: ["sess-1"], files: ["/work/b.js"] }];
    },
    ack: (commits, opts) => acked.push({ commits, opts }),
    repos: () => ["/work"],
    files: () => [],
  };
  const store = {
    iterEvents: () => [{ conversation_id: "sess-1", affected_git: [{ root: "/work" }] }],
    append: (row) => appended.push(row),
  };
  const exportSession = (cid, opts) => {
    published.push({ cid, opts });
    return { publish: { ok: true, target: "repo/sess.tgz" } };
  };

  tick({ store, watched, exportSession });
  tick({ store, watched, exportSession });

  assert.equal(published.length, 2);
  assert.equal(appended[0].git_head_change.sha, "bbb");
  assert.equal(appended[1].git_head_change.sha, "ccc");
  assert.equal(acked.length, 2);
  assert.equal(acked[0].commits[0].sha, "bbb");
  assert.equal(acked[1].commits[0].sha, "ccc");
  assert.equal(acked[0].opts && acked[0].opts.revert, undefined);
});

test("tick reverts logged HEAD when every matching session fails to publish", () => {
  const acked = [];
  tick({
    store: {
      iterEvents: () => [],
      append: () => {},
    },
    watched: {
      detectCommits: () => [{ root: "/work", sha: "bbb", previous: "aaa", cids: ["sess-1"], files: ["/work/a.js"] }],
      ack: (commits, opts) => acked.push({ commits, opts }),
      repos: () => ["/work"],
      files: () => [],
    },
    exportSession: () => ({ error: "upload failed", publish: { ok: false } }),
  });
  assert.equal(acked.length, 1);
  assert.equal(acked[0].opts.revert, true);
  assert.equal(acked[0].commits[0].sha, "bbb");
});

test("tick dry-run does not stamp logs or publish", () => {
  const appended = [];
  const published = [];
  tick({
    dryRun: true,
    store: { iterEvents: () => [], append: (row) => appended.push(row) },
    watched: {
      detectCommits: () => [{ root: "/work", sha: "bbb", previous: "aaa", cids: ["sess-1"] }],
      repos: () => ["/work"],
      files: () => [],
    },
    exportSession: (cid, opts) => {
      published.push({ cid, opts });
      return { publish: { ok: true } };
    },
  });
  assert.equal(appended.length, 0);
  assert.equal(published.length, 1);
  assert.equal(published[0].opts.publish, false);
});
