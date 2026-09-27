"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname);
const GLOBAL_DIR = path.join(os.homedir(), ".cursor", "agentic-bom");
const SETTINGS_PATH = path.join(GLOBAL_DIR, "settings.json");

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeSettings(partial) {
  const next = Object.assign({}, loadSettings(), partial || {});
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  if (next.data_dir) fs.mkdirSync(next.data_dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + "\n");
  return next;
}

function dataDir() {
  if (process.env.AGENTIC_BOM_DATA) return path.resolve(process.env.AGENTIC_BOM_DATA);
  const s = loadSettings();
  if (s.data_dir) return path.resolve(s.data_dir);
  return GLOBAL_DIR;
}

function defaultDbPath() {
  if (process.env.MONITORING_DB) return path.resolve(process.env.MONITORING_DB);
  const s = loadSettings();
  if (s.monitoring_db) return path.resolve(s.monitoring_db);
  return path.join(dataDir(), "events.jsonl");
}

function installGlobalData(opts) {
  opts = opts || {};
  const dir = opts.dataDir
    ? path.resolve(opts.dataDir)
    : (process.env.AGENTIC_BOM_DATA ? path.resolve(process.env.AGENTIC_BOM_DATA) : GLOBAL_DIR);
  const monitoringDb = process.env.MONITORING_DB
    ? path.resolve(process.env.MONITORING_DB)
    : path.join(dir, "events.jsonl");
  return writeSettings({ data_dir: dir, monitoring_db: monitoringDb });
}

function load(rel) {
  return require(path.join(ROOT, rel));
}

module.exports = {
  ROOT,
  get DATA() {
    return dataDir();
  },
  GLOBAL_DIR,
  SETTINGS_PATH,
  loadSettings,
  writeSettings,
  dataDir,
  defaultDbPath,
  installGlobalData,
  load,
};
