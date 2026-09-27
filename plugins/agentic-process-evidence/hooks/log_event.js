#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { SETTINGS_PATH, installGlobalData } = require("../paths");
const { run } = require("./runtime");
const { FileHashHandler } = require("../change_detector/filehash");
const { GitCoordinateHandler } = require("../git_finder/bind");
const { StoreHandler } = require("../local_storage/db");
const { LivePublishHandler } = require("../artifactory_interface/live_publish");

try {
  if (!fs.existsSync(SETTINGS_PATH)) installGlobalData();
} catch {}

const event = process.argv[2] || "unknown";
run(event, [
  new FileHashHandler(),
  new GitCoordinateHandler(),
  new StoreHandler(),
  new LivePublishHandler(),
]);
