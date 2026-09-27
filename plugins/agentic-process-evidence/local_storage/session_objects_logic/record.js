"use strict";

const LARGE_FIELDS = ["tool_output", "output", "content", "result_json"];
const MAX_LARGE_CHARS = 20000;

function capLargeFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  for (const key of LARGE_FIELDS) {
    const val = obj[key];
    if (typeof val === "string" && val.length > MAX_LARGE_CHARS) {
      obj[key] = val.slice(0, MAX_LARGE_CHARS)
        + "\n...[truncated " + (val.length - MAX_LARGE_CHARS) + " chars by audit logger]...";
    }
  }
  return obj;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function localIso() {
  const d = new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
    + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function normalize(event, payload) {
  const record = capLargeFields(Object.assign({}, payload));
  record.event = payload.hook_event_name || event;
  record.ts = Date.now() / 1000;
  record.ts_iso = localIso();
  return record;
}

function eventName(record) {
  return record.event || record.hook_event_name || "unknown";
}

function conversationId(record) {
  return record.conversation_id || record.session_id || "unknown";
}

function toolInput(record) {
  const ti = record.tool_input;
  return ti && typeof ti === "object" && !Array.isArray(ti) ? ti : {};
}

function commandOf(record) {
  return record.command || toolInput(record).command;
}

function eventCwd(record) {
  const ti = toolInput(record);
  const cwd = ti.cwd || record.cwd || record.workspacePath;
  if (cwd) return cwd;
  const roots = record.workspace_roots;
  if (Array.isArray(roots) && roots.length) return roots[0];
  if (typeof roots === "string" && roots) return roots;
  return null;
}

function snippet(record) {
  const ev = eventName(record);
  if (ev === "beforeSubmitPrompt") return record.prompt || "";
  if (ev === "afterAgentResponse" || ev === "afterAgentThought") return record.text || "";
  if (ev === "beforeShellExecution" || ev === "afterShellExecution") return record.command || "";
  if (ev === "beforeReadFile" || ev === "afterFileEdit") return record.file_path || "";
  if (ev === "preToolUse" || ev === "postToolUse" || ev === "postToolUseFailure") {
    const ti = toolInput(record);
    const extra = ti.command || ti.file_path || ti.query || "";
    return ((record.tool_name || "") + (extra ? "  " + extra : "")).trim();
  }
  if (ev === "beforeMCPExecution" || ev === "afterMCPExecution") {
    return record.tool_name || record.url || "";
  }
  if (ev === "subagentStart" || ev === "subagentStop") {
    return record.task || record.subagent_type || "";
  }
  if (ev === "stop") return "status=" + (record.status || "");
  if (ev === "preCompact") return "compaction " + (record.context_usage_percent || "?") + "%";
  return "";
}

module.exports = {
  normalize,
  eventName,
  conversationId,
  toolInput,
  commandOf,
  eventCwd,
  snippet,
};
