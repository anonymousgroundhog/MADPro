#!/usr/bin/env node
// Inspect a single APK and print JSON to stdout. Called by kanban as a subprocess.
// Usage: node inspect-worker.js <apkPath>
"use strict";
const { inspectApk } = require("./apk_inspector");
const apkPath = process.argv[2];
if (!apkPath) { console.log("{}"); process.exit(0); }
try {
  const r = inspectApk(apkPath);
  console.log(JSON.stringify({ hasAds: r.hasAds, adSdks: r.adSdks,
    hasPlayStoreTraces: r.hasPlayStoreTraces, playStoreTraces: r.playStoreTraces }));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
}
