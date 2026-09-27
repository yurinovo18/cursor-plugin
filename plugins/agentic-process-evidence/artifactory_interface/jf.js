"use strict";

const { spawnSync } = require("child_process");

function sh(cmd) {
  return spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
}

function parseServerBlock(block) {
  const id = (block.match(/Server ID:\s+(\S+)/) || [])[1] || "";
  const art = (block.match(/Artifactory URL:\s+(\S+)/) || [])[1] || "";
  const platform = (block.match(/JFrog Platform URL:\s+(\S+)/) || [])[1] || "";
  const isDefault = /Default:\s+true/i.test(block);
  const artifactoryUrl = (art || (platform ? platform.replace(/\/$/, "") + "/artifactory" : "")).replace(/\/$/, "");
  return { id, artifactoryUrl, isDefault };
}

function listServers() {
  const res = sh(["jf", "config", "show"]);
  const text = res.stdout || "";
  return text.split(/\n(?=Server ID:)/).map(parseServerBlock).filter((s) => s.id);
}

function defaultServer() {
  const servers = listServers();
  return servers.find((s) => s.isDefault) || servers[0] || { id: "", artifactoryUrl: "" };
}

function serverById(id) {
  if (!id) return defaultServer();
  const res = sh(["jf", "config", "show", id]);
  if (res.status === 0 && (res.stdout || "").includes("Server ID:")) {
    return parseServerBlock(res.stdout);
  }
  return listServers().find((s) => s.id === id) || { id, artifactoryUrl: "" };
}

/** Active jf CLI server: JF_SERVER, else the config marked Default. Empty means omit --server-id. */
function resolveServerId() {
  const explicit = (process.env.JF_SERVER || "").trim();
  if (explicit) return explicit;
  return defaultServer().id || "";
}

function resolveArtifactoryUrl(serverId) {
  const explicit = (process.env.JF_ARTIFACTORY_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  return serverById(serverId || resolveServerId()).artifactoryUrl || "";
}

function withServer(cmd, serverId) {
  const id = serverId == null ? resolveServerId() : serverId;
  if (id) cmd.push("--server-id=" + id);
  return cmd;
}

module.exports = {
  sh,
  resolveServerId,
  resolveArtifactoryUrl,
  withServer,
  defaultServer,
};
