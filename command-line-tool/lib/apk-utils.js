/**
 * lib/apk-utils.js
 * XAPK extraction and APK normalization helpers.
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

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
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const xapkFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith(".xapk"));

  for (const entry of xapkFiles) {
    const xapkPath = path.join(dirPath, entry.name);
    const extractDir = path.join(dirPath, entry.name.slice(0, -5));
    try {
      console.log(`  Extracting XAPK: ${entry.name}`);
      fs.mkdirSync(extractDir, { recursive: true });
      execSync(`unzip -q -o "${xapkPath}" -d "${extractDir}"`, { stdio: "pipe" });
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
      fs.unlinkSync(xapkPath);
      console.log(`  [OK] Extracted: ${path.basename(extractDir)}`);
    } catch (err) {
      console.error(`  [ERROR] Failed to extract ${entry.name}: ${err.message}`);
    }
  }
}

module.exports = { normalizeApksInDir, extractXapksInDir };
