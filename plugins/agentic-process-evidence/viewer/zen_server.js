"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const session = require("./session");

const INDEX_PATH = path.join(__dirname, "zen.html");
const PORT = Number(process.env.ZEN_PORT || 8790);

function send(res, code, body, ctype) {
  const data = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, {
    "Content-Type": ctype || "application/json",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function handler(req, res) {
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && u.pathname === "/api/pulse") {
      return send(res, 200, session.buildPulse());
    }
    if (req.method === "GET" && u.pathname === "/api/session") {
      const cid = u.searchParams.get("cid") || "";
      if (!cid) return send(res, 400, { error: "cid required" });
      const threshold = Number(u.searchParams.get("threshold") || 0);
      return send(res, 200, session.buildSession(cid, threshold));
    }
    if (req.method === "POST" && u.pathname === "/api/session/publish") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const body = JSON.parse(raw || "{}");
          const cid = body.cid || body.conversation_id;
          if (!cid) return send(res, 400, { error: "cid required" });
          const { exportSession } = require("../artifactory_interface/export_session");
          return send(res, 200, exportSession(cid, { publish: true, dryRun: Boolean(body.dry_run) }));
        } catch (exc) {
          return send(res, 500, { error: String(exc) });
        }
      });
      return;
    }
    if (req.method === "GET") {
      const html = fs.readFileSync(INDEX_PATH, "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    return send(res, 404, { error: "not found" });
  } catch (exc) {
    return send(res, 500, { error: String(exc) });
  }
}

function main() {
  console.log("apptrust zen (node slim):  http://localhost:" + PORT);
  console.log("Event DB:                  " + session.DB_PATH);
  http.createServer(handler).listen(PORT, "127.0.0.1");
}

if (require.main === module) main();
