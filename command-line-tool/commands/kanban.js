/**
 * commands/kanban.js
 * Scans an APK directory, enriches each app with Play Store metadata (or static
 * APK inspection), and streams results to a CSV file row-by-row.
 *
 * Only apps with a real package name (≥ 3 dot-separated segments) are processed.
 *
 * Memory strategy:
 *  - Scan array is converted to a Map and released immediately.
 *  - APK inspection runs in a subprocess (inspect-worker.js) so the 256MB DEX
 *    buffer is freed on subprocess exit, not held in the main process heap.
 *  - Play Store cache is cleared after each lookup — results are written to CSV
 *    immediately and not kept in memory.
 *  - Concurrency is capped at 1 to keep only one HTML response + one subprocess
 *    in flight at a time.
 */

"use strict";

const path      = require("path");
const os        = require("os");
const fs        = require("fs");
const { spawnSync } = require("child_process");

const { scanApks }                    = require("../lib/scanner");
const { lookupPlayStore, clearCache } = require("../lib/playstore");

const WORKER = path.join(__dirname, "../lib/inspect-worker.js");

function isRealPackage(pkg) {
  return typeof pkg === "string"
    && /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){2,}$/.test(pkg);
}

function csvEsc(v) {
  if (v == null) return "";
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

const CSV_HEADER = [
  "package", "appName", "hasAds", "adSdks", "rating", "downloads",
  "category", "stillOnStore", "storeUrl", "scanMethod", "primaryApk",
].join(",");

function buildCsvRow(app, sd) {
  return [
    app.package,
    sd.appName || app.appName || "",
    sd.hasAds == null ? "" : sd.hasAds,
    (sd.adSdks || []).join("|"),
    sd.rating    || "",
    sd.downloads || "",
    sd.category  || "",
    sd.stillOnStore == null ? "" : sd.stillOnStore,
    sd.storeUrl  || "",
    sd.scanMethod || "",
    app.primaryApk,
  ].map(csvEsc).join(",");
}

// Run APK inspection in a child process so the large DEX buffer is freed on exit.
function inspectApkSubprocess(apkPath) {
  const r = spawnSync(process.execPath, [WORKER, apkPath], {
    encoding: "utf8",
    timeout: 60000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout.trim()); } catch { return null; }
}

function register(program) {
  program
    .command("kanban")
    .description("Scan APK directory and write ads/no-ads results to CSV")
    .argument("<dir>", "Directory containing APK files")
    .option("-o, --out <file>", "Output CSV filename (saved inside <dir> by default)")
    .option("--no-store", "Skip Play Store lookup; use static APK inspection only")
    .action(async (dir, opts) => {
      const absDir = path.resolve(dir.replace(/^~/, os.homedir()));

      const outFile = opts.out
        ? path.resolve(opts.out)
        : path.join(absDir, `kanban-${Date.now()}.csv`);

      console.log(`Scanning ${absDir} …`);
      let all;
      try { all = scanApks(absDir); }
      catch (err) { console.error("Scan failed:", err.message); process.exit(1); }

      // Build pkg → [app, …] map then release the flat array
      const pkgMap = new Map();
      let totalGroups = all.length;
      let skipped = 0;
      for (const app of all) {
        if (!isRealPackage(app.package)) { skipped++; continue; }
        if (!pkgMap.has(app.package)) pkgMap.set(app.package, []);
        pkgMap.get(app.package).push({
          package:    app.package,
          appName:    app.appName,
          primaryApk: app.primaryApk,
        });
      }
      all = null;

      const uniquePkgs = [...pkgMap.keys()];
      const total = uniquePkgs.length;
      console.log(`${totalGroups} APK group(s) — ${totalGroups - skipped} with package names, ${skipped} helper/split skipped.`);
      console.log(`Output → ${outFile}\n`);

      if (!total) { console.log("No apps with package names found."); process.exit(0); }

      const fd = fs.openSync(outFile, "w");
      fs.writeSync(fd, CSV_HEADER + "\n");

      let done = 0, nAds = 0, nNoAds = 0, nUnknown = 0;

      for (const pkg of uniquePkgs) {
        const appList = pkgMap.get(pkg);
        const rep = appList[0];
        let sd;

        clearCache(); // discard previous result — never accumulate in CACHE

        if (opts.store === false) {
          const scan = inspectApkSubprocess(rep.primaryApk);
          sd = scan
            ? { appName: null, rating: null, downloads: null,
                hasAds: scan.hasAds, adSdks: scan.adSdks,
                storeUrl: null, stillOnStore: false, scanMethod: "apk-scan" }
            : { appName: null, rating: null, downloads: null, hasAds: null,
                storeUrl: null, stillOnStore: false, scanMethod: "apk-scan-failed" };
        } else {
          sd = await lookupPlayStore(pkg);
          if (!sd.stillOnStore) {
            const scan = inspectApkSubprocess(rep.primaryApk);
            if (scan) {
              sd = { ...sd, hasAds: scan.hasAds, adSdks: scan.adSdks,
                     hasPlayStoreTraces: scan.hasPlayStoreTraces,
                     playStoreTraces: scan.playStoreTraces, scanMethod: "apk-scan" };
            } else {
              sd = { ...sd, scanMethod: "apk-scan-failed" };
            }
          }
        }

        for (const app of appList) {
          fs.writeSync(fd, buildCsvRow(app, sd) + "\n");
        }
        pkgMap.delete(pkg);

        if (sd.hasAds === true)       nAds++;
        else if (sd.hasAds === false) nNoAds++;
        else                          nUnknown++;

        done++;
        process.stdout.write(`Enriching ${done} / ${total} …\r`);
      }

      fs.closeSync(fd);
      process.stdout.write(`Done.                      \n\n`);
      console.log(`Results: ${nAds} has-ads  |  ${nNoAds} no-ads  |  ${nUnknown} unknown`);
      console.log(`CSV written to: ${outFile}`);
    });
}

module.exports = { register };
