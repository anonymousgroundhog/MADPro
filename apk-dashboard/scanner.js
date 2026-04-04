/**
 * scanner.js
 * Recursively discovers APK files (any depth) and extracts package metadata
 * using aapt2 (preferred) or aapt if available. Falls back to filename parsing.
 */

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// ── Tool detection ──────────────────────────────────────────────────────────

function findAapt() {
  for (const tool of ["aapt2", "aapt"]) {
    try {
      execSync(`which ${tool}`, { stdio: "ignore" });
      return tool;
    } catch {}
  }
  // Check common Android SDK paths
  const sdkPaths = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env.HOME || "", "Android/Sdk"),
  ].filter(Boolean);

  for (const sdk of sdkPaths) {
    try {
      const dirs = fs.readdirSync(path.join(sdk, "build-tools")).reverse();
      for (const dir of dirs) {
        for (const bin of ["aapt2", "aapt"]) {
          const p = path.join(sdk, "build-tools", dir, bin);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch {}
  }
  return null;
}

const AAPT = findAapt();

// ── APK metadata extraction ─────────────────────────────────────────────────

function parseAaptDump(apkPath) {
  if (!AAPT) return null;
  try {
    const result = spawnSync(AAPT, ["dump", "badging", apkPath], {
      encoding: "utf8",
      timeout: 15000,
    });
    if (result.status !== 0 && !result.stdout) return null;
    const out = result.stdout || "";

    const pkg = out.match(/^package: name='([^']+)'/m)?.[1] ?? null;
    const versionName = out.match(/^package:[^\n]*versionName='([^']+)'/m)?.[1] ?? null;
    const versionCode = out.match(/^package:[^\n]*versionCode='([^']+)'/m)?.[1] ?? null;
    const label =
      out.match(/^application-label-en:'([^']+)'/m)?.[1] ??
      out.match(/^application-label:'([^']+)'/m)?.[1] ??
      null;

    return { package: pkg, appName: label, versionName, versionCode };
  } catch {
    return null;
  }
}

function metaFromPath(apkPath, label) {
  // Derive package name from directory structure or filename
  // e.g. com.example.app/base.apk  or  com.example.app.apk
  const dir = path.basename(path.dirname(apkPath));
  const file = path.basename(apkPath, ".apk");

  let pkg = null;
  // Looks like a package name if it has dots and no spaces
  if (/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(dir)) pkg = dir;
  else if (/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(file)) pkg = file;
  else if (label && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(label)) pkg = label;

  return { package: pkg, appName: null, versionName: null, versionCode: null };
}

// ── Recursive APK discovery ─────────────────────────────────────────────────

function walkDir(dir) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkDir(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".apk")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Groups APKs by their parent directory (split-APK aware).
 * Returns one AppEntry per logical app.
 */
function groupApks(baseDir) {
  const allApks = walkDir(baseDir);
  const byDir = new Map();

  for (const apkPath of allApks) {
    const dir = path.dirname(apkPath);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(apkPath);
  }

  const entries = [];
  for (const [dir, apks] of byDir) {
    const sorted = apks.slice().sort();
    const relDir = path.relative(baseDir, dir) || ".";

    // If this directory looks like a split-APK bundle (contains base.apk, or all files
    // share the same package name prefix), treat it as one app.
    const hasBase = sorted.some((p) => path.basename(p).toLowerCase() === "base.apk");

    if (relDir !== ".") {
      // Subdirectory — treat all APKs as one app (split APK bundle).
      // Primary: prefer base.apk, then the largest file (most likely the main APK).
      const primary =
        sorted.find((p) => path.basename(p).toLowerCase() === "base.apk") ||
        sorted.reduce((best, p) => {
          try { return fs.statSync(p).size > fs.statSync(best).size ? p : best; } catch { return best; }
        }, sorted[0]);
      const label = relDir.replace(/\\/g, "/");
      entries.push({ dir, apks: sorted, primary, label });
    } else {
      // Root directory — every APK file is its own independent app
      for (const apkPath of sorted) {
        const label = path.basename(apkPath, ".apk");
        entries.push({ dir, apks: [apkPath], primary: apkPath, label });
      }
    }
  }

  return entries.sort((a, b) => a.label.localeCompare(b.label));
}

// ── Main scan function ──────────────────────────────────────────────────────

/**
 * Scans baseDir recursively and returns an array of app metadata objects.
 * Each object: { package, appName, label, apkFiles, primaryApk, versionName, versionCode, aaptAvailable }
 */
function scanApks(baseDir) {
  const groups = groupApks(baseDir);
  return groups.map(({ dir, apks, primary, label }) => {
    const aapt = parseAaptDump(primary);
    const fallback = metaFromPath(primary, label);

    const pkg = aapt?.package ?? fallback.package ?? label;
    const appName = aapt?.appName ?? null;

    return {
      id: pkg || label,
      package: pkg,
      appName: appName || pkg || label,
      label,
      apkFiles: apks,
      primaryApk: primary,
      versionName: aapt?.versionName ?? null,
      versionCode: aapt?.versionCode ?? null,
      apkDir: dir,
      aaptAvailable: !!AAPT,
    };
  });
}

module.exports = { scanApks, AAPT };
