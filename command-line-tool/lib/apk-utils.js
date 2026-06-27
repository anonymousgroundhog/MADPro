/**
 * lib/apk-utils.js
 * XAPK extraction and APK normalization helpers.
 */

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function isMultiPartZip(filePath) {
  // zipinfo exits 1 with a "disk N" warning when the file is a partial multi-part archive
  const r = spawnSync("zipinfo", ["-1", filePath], { stdio: "pipe" });
  const stderr = (r.stderr || Buffer.alloc(0)).toString();
  return stderr.includes("disk") && stderr.includes("central directory");
}

function unzipTo(src, dest) {
  const result = spawnSync("unzip", ["-q", "-o", src, "-d", dest], { stdio: "pipe" });
  if (result.status !== 0) {
    const msg = (result.stderr || Buffer.alloc(0)).toString().trim() || `exit code ${result.status}`;
    throw new Error(msg);
  }
}

function normalizeApksInDir(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const apkFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith(".apk"));
  if (!apkFiles.length) return;
  if (apkFiles.some(f => f.name.toLowerCase() === "base.apk")) return;

  const dirName = path.basename(dirPath);
  let mainApk =
    apkFiles.find(f => f.name.toLowerCase() === "app.apk") ||
    apkFiles.find(f => f.name.toLowerCase().startsWith(dirName.toLowerCase())) ||
    apkFiles.find(f => !f.name.toLowerCase().startsWith("config.") && !f.name.toLowerCase().startsWith("split_config."));

  if (mainApk) {
    try {
      fs.renameSync(path.join(dirPath, mainApk.name), path.join(dirPath, "base.apk"));
      console.log(`  Renamed ${mainApk.name} → base.apk`);
    } catch (err) {
      console.warn(`  [WARN] Could not rename ${mainApk.name}: ${err.message}`);
    }
  }
}

function extractXapksInDir(dirPath) {
  if (!fs.existsSync(dirPath)) return;

  // Rename any leftover .xapk.zip back to .xapk (from a previously interrupted run)
  for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (e.isFile() && e.name.toLowerCase().endsWith(".xapk.zip")) {
      const from = path.join(dirPath, e.name);
      const to   = from.slice(0, -4); // strip .zip
      try { fs.renameSync(from, to); } catch {}
    }
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const xapkFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith(".xapk"));

  for (const entry of xapkFiles) {
    const xapkPath = path.join(dirPath, entry.name);
    const extractDir = path.join(dirPath, entry.name.slice(0, -5));
    try {
      console.log(`  Extracting XAPK: ${entry.name}`);

      if (isMultiPartZip(xapkPath)) {
        const corruptPath = xapkPath + ".corrupt";
        try { fs.renameSync(xapkPath, corruptPath); } catch {}
        console.warn(`  [SKIP] ${entry.name}: incomplete multi-part archive (corrupt download) — renamed to .corrupt`);
        continue;
      }

      fs.mkdirSync(extractDir, { recursive: true });
      let unzipSource = xapkPath;
      try {
        unzipTo(xapkPath, extractDir);
      } catch {
        // Some XAPKs require the .zip extension to be recognized
        const zipPath = xapkPath + ".zip";
        fs.renameSync(xapkPath, zipPath);
        unzipSource = zipPath;
        unzipTo(zipPath, extractDir);
      }
      normalizeApksInDir(extractDir);

      const files = fs.readdirSync(extractDir);
      const apkFiles = files.filter(f => f.toLowerCase().endsWith(".apk"));
      if (apkFiles.length) console.log(`    Found ${apkFiles.length} APK file(s)`);

      for (const file of files) {
        if (!file.toLowerCase().endsWith(".apk")) {
          const filePath = path.join(extractDir, file);
          if (fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
        }
      }
      try { fs.unlinkSync(unzipSource); } catch {}
      console.log(`  [OK] Extracted: ${path.basename(extractDir)}`);
    } catch (err) {
      console.error(`  [ERROR] Failed to extract ${entry.name}: ${err.message}`);
    }
  }
}

module.exports = { normalizeApksInDir, extractXapksInDir };
