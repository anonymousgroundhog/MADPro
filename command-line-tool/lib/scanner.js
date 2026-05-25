/**
 * lib/scanner.js
 * Recursive APK discovery + metadata extraction via aapt/aapt2.
 * Mirrors apk-dashboard/scanner.js but standalone (no server deps).
 */

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function findAapt() {
  for (const tool of ["aapt2", "aapt"]) {
    try { execSync(`which ${tool}`, { stdio: "ignore" }); return tool; } catch {}
  }
  const sdkPaths = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env.HOME || "", "Android/Sdk"),
  ].filter(Boolean);
  for (const sdk of sdkPaths) {
    try {
      const dirs = fs.readdirSync(path.join(sdk, "build-tools")).sort().reverse();
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

function parseAaptDump(apkPath) {
  if (!AAPT) return null;
  try {
    const r = spawnSync(AAPT, ["dump", "badging", apkPath], { encoding: "utf8", timeout: 15000 });
    if (r.status !== 0 && !r.stdout) return null;
    const out = r.stdout || "";
    return {
      package:     out.match(/^package: name='([^']+)'/m)?.[1]         ?? null,
      versionName: out.match(/^package:[^\n]*versionName='([^']+)'/m)?.[1] ?? null,
      versionCode: out.match(/^package:[^\n]*versionCode='([^']+)'/m)?.[1] ?? null,
      appName:
        out.match(/^application-label-en:'([^']+)'/m)?.[1] ??
        out.match(/^application-label:'([^']+)'/m)?.[1]    ?? null,
    };
  } catch { return null; }
}

function walkDir(dir, maxDepth = 5, depth = 0) {
  let results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  if (depth >= maxDepth) return results;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) results = results.concat(walkDir(full, maxDepth, depth + 1));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".apk")) results.push(full);
  }
  return results;
}

function groupApks(baseDir) {
  let childCount = 0;
  try { childCount = fs.readdirSync(baseDir).length; } catch {}
  const maxDepth = childCount > 1000 ? 2 : 5;
  const allApks = walkDir(baseDir, maxDepth);
  const byDir = new Map();
  for (const p of allApks) {
    const d = path.dirname(p);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(p);
  }

  const entries = [];
  for (const [dir, apks] of byDir) {
    const sorted = apks.slice().sort();
    const isBase = path.resolve(dir) === path.resolve(baseDir);
    const hasBase = sorted.some(p => path.basename(p).toLowerCase() === "base.apk");
    const hasSplits = sorted.length > 1 && sorted.some(p =>
      /^(config\.|split_config\.)/.test(path.basename(p).toLowerCase()));
    const isSplitBundle = hasBase || hasSplits;

    if (!isBase && isSplitBundle) {
      const primary =
        sorted.find(p => path.basename(p).toLowerCase() === "base.apk") ||
        sorted.reduce((b, p) => {
          try { return fs.statSync(p).size > fs.statSync(b).size ? p : b; } catch { return b; }
        }, sorted[0]);
      entries.push({ dir, apks: sorted, primary, label: path.relative(baseDir, dir).replace(/\\/g, "/") });
    } else {
      for (const p of sorted) {
        const rel = path.relative(baseDir, p).replace(/\\/g, "/");
        entries.push({ dir, apks: [p], primary: p, label: rel.replace(/\.apk$/i, "") });
      }
    }
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label));
}

// skipAapt=true: returns only file paths and labels; no aapt invocations.
// Use this for injection where metadata is not needed and the APK set may be large.
function scanApks(baseDir, { skipAapt = false } = {}) {
  const groups = groupApks(baseDir);
  if (groups.length > 5000) {
    console.warn(`Warning: ${groups.length} apps found; truncating to 5000`);
    groups.length = 5000;
  }
  return groups.map(({ dir, apks, primary, label }) => {
    if (skipAapt) {
      return {
        id: label,
        package: null,
        appName: label,
        label,
        apkFiles: apks,
        primaryApk: primary,
        versionName: null,
        versionCode: null,
        apkDir: dir,
        aaptAvailable: !!AAPT,
      };
    }
    const aapt = parseAaptDump(primary);
    const pkg  = aapt?.package ?? label;
    return {
      id: pkg || label,
      package: pkg,
      appName: aapt?.appName ?? pkg ?? label,
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
