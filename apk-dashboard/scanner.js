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

function walkDir(dir, maxDepth = 5, currentDepth = 0) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  // Limit recursion depth to prevent scanning extremely deep directory trees
  if (currentDepth >= maxDepth) return results;

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkDir(full, maxDepth, currentDepth + 1));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".apk")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Groups APKs by their immediate parent directory (split-APK aware).
 * Every directory that directly contains at least one APK is treated as
 * one logical app — regardless of how many levels deep it sits.
 * APKs sitting directly in baseDir (depth 0) each become their own app.
 *
 * Limits scanning to prevent hangs with massive collections (e.g., 3000+ directories).
 */
function groupApks(baseDir) {
  // Quick sanity check: if base directory has too many immediate children, warn and limit depth
  let immediateChildren = 0;
  try {
    immediateChildren = fs.readdirSync(baseDir).length;
  } catch {}

  const maxDepth = immediateChildren > 1000 ? 2 : 5;
  const allApks = walkDir(baseDir, maxDepth);
  const byDir = new Map();

  for (const apkPath of allApks) {
    const dir = path.dirname(apkPath);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(apkPath);
  }

  const entries = [];
  for (const [dir, apks] of byDir) {
    const sorted = apks.slice().sort();
    const isBaseDir = path.resolve(dir) === path.resolve(baseDir);

    // Detect split-APK bundle: a directory containing base.apk, or multiple APKs
    // where at least one is named base.apk or *.apk (config split naming).
    const hasBase = sorted.some((p) => path.basename(p).toLowerCase() === "base.apk");
    const hasSplits = sorted.length > 1 && sorted.some((p) =>
      /^(config\.|split_config\.)/.test(path.basename(p).toLowerCase())
    );
    const isSplitBundle = hasBase || hasSplits;

    if (!isBaseDir && isSplitBundle) {
      // Split-APK bundle — all APKs in this dir belong to one app
      const primary =
        sorted.find((p) => path.basename(p).toLowerCase() === "base.apk") ||
        sorted.reduce((best, p) => {
          try { return fs.statSync(p).size > fs.statSync(best).size ? p : best; } catch { return best; }
        }, sorted[0]);
      const relDir = path.relative(baseDir, dir).replace(/\\/g, "/");
      entries.push({ dir, apks: sorted, primary, label: relDir });
    } else {
      // Either the base dir, or a subdirectory with flat (non-bundle) APKs —
      // every APK file is its own independent app.
      for (const apkPath of sorted) {
        const relPath = path.relative(baseDir, apkPath).replace(/\\/g, "/");
        const label = relPath.replace(/\.apk$/i, "");
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
 *
 * Limits results to 5000 apps to prevent UI hangs with massive directories.
 */
function scanApks(baseDir) {
  const groups = groupApks(baseDir);
  const MAX_APPS = 5000;

  // If there are too many apps, truncate and warn
  if (groups.length > MAX_APPS) {
    console.warn(`⚠ Directory contains ${groups.length} apps. Limiting to ${MAX_APPS} for performance.`);
    groups.length = MAX_APPS;
  }

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
