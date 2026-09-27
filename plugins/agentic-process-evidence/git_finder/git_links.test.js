"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { enrichCommitTags } = require("./git_links");

test("enrichCommitTags includes gitHeadChanged shas so a later commit in the session is indexed", () => {
  const session = {
    conversation_id: "sess-1",
    git_remotes: [{
      remote: "git@example/work.git",
      name: "work",
      root: "/work",
      branch: "main",
      commits: [{ sha: "aaa111", short: "aaa111", subject: "first", files: ["a.js"] }],
    }],
    timeline: [],
  };
  const events = [
    { ts_iso: "2026-09-17T14:00:00", event: "beforeSubmitPrompt" },
    {
      event: "gitHeadChanged",
      git_head_change: { root: "/work", previous: "aaa111", sha: "bbb222", files: ["/work/b.js"] },
    },
  ];
  const tags = enrichCommitTags(session, events);
  const shas = tags.map((t) => t.sha).sort();
  assert.ok(shas.includes("aaa111"));
  assert.ok(shas.includes("bbb222"));
  const second = tags.find((t) => t.sha === "bbb222");
  assert.equal(second.role, "session_authored");
  assert.equal(second.repo_root, "/work");
});
