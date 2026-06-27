/**
 * commands/log-view.js
 * `madpro log-view` — scan log dir, filter by app/keywords, print results,
 *   optionally pop up FSM model image.
 */

"use strict";

const path    = require("path");
const fs      = require("fs");
const os      = require("os");
const { spawn } = require("child_process");

const NATIVELOADER_PKG_RE = /\/data\/app\/~~[^/]+\/([a-zA-Z][a-zA-Z0-9_.]*)-[A-Za-z0-9_]+=+=\//g;

function extractAppPackages(content) {
  const found = new Set();
  NATIVELOADER_PKG_RE.lastIndex = 0;
  let m;
  while ((m = NATIVELOADER_PKG_RE.exec(content)) !== null) found.add(m[1]);
  return [...found];
}

function parseLogEntries(absPath) {
  const content = fs.readFileSync(absPath, "utf8");
  const MARKER  = "Entering: ";
  const SIG_RE  = /^<(.+):\s+(\S+)\s+([^(]+)\(([^)]*)\)>$/;
  const entries = [];
  const seen    = new Set();
  for (const line of content.split("\n")) {
    const idx = line.indexOf(MARKER);
    if (idx === -1) continue;
    const sig = line.slice(idx + MARKER.length).trim();
    const m   = SIG_RE.exec(sig);
    if (m) {
      const className  = m[1].trim();
      const returnType = m[2].trim();
      const methodName = m[3].trim();
      const args       = m[4].trim();
      const key = `${className}#${methodName}(${args})`;
      entries.push({ className, returnType, methodName, args, sig, key, duplicate: seen.has(key) });
      seen.add(key);
    } else {
      entries.push({ className: null, returnType: null, methodName: null, args: null, sig, key: sig, duplicate: false });
    }
  }
  return entries;
}

function entryMatchesQuery(e, queryLow) {
  if (e.methodName) {
    const mn = e.methodName.toLowerCase();
    if (mn.includes(queryLow)) return true;
    if ((e.methodName + "(").toLowerCase().includes(queryLow)) return true;
  }
  return e.sig ? e.sig.toLowerCase().includes(queryLow) : false;
}

function entryMatchesPkg(e, pkgPatterns) {
  if (!pkgPatterns.length) return true;
  const cls = (e.className || e.sig || "").toLowerCase();
  return pkgPatterns.some(p => cls.includes(p));
}

function formatEntry(e) {
  if (e.className) {
    return `  ${e.className} → ${e.returnType} ${e.methodName}(${e.args})`;
  }
  return `  ${e.sig}`;
}

function openImageViewer(imgPath) {
  const viewers = ["eog", "feh", "gpicview", "eom", "xdg-open"];
  for (const v of viewers) {
    try {
      spawn(v, [imgPath], { detached: true, stdio: "ignore" }).unref();
      return v;
    } catch { /* try next */ }
  }
  return null;
}

function resolveDir(d) {
  return path.resolve((d || "~/MADPro_Logcat").replace(/^~/, os.homedir()));
}

function listLogFiles(absDir) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith(".log"))
    .map(e => path.join(absDir, e.name))
    .sort();
}

function register(program) {
  program
    .command("log-view")
    .description("Scan log directory and display filtered log entries per app")
    .argument("<dir>", "Directory containing .log files (e.g. ~/MADPro_Logcat)")
    .option("-a, --app <package>",      "Filter to specific app package (partial match)")
    .option("-k, --keywords <words>",   "Comma-separated keywords to filter entries (e.g. onCreate,onPause)")
    .option("-p, --pkg-filter <pats>",  "Comma-separated class/package patterns (e.g. com.google.android)")
    .option("--no-dedup",               "Show duplicate entries (default: hide)")
    .option("--fsm [image]",            "Pop up FSM model image (default: <project-root>/model.png)")
    .option("--list-apps",              "List detected apps in dir and exit")
    .action((dir, opts) => {
      const absDir = resolveDir(dir);

      if (!fs.existsSync(absDir)) {
        console.error(`Directory not found: ${absDir}`);
        process.exit(1);
      }

      let logFiles;
      try { logFiles = listLogFiles(absDir); }
      catch (err) { console.error("Cannot read dir:", err.message); process.exit(1); }

      if (!logFiles.length) {
        console.log("No .log files found in", absDir);
        process.exit(0);
      }

      // Scan all files for app packages
      const pkgMap = new Map(); // pkg → [absFilePath, ...]
      for (const fp of logFiles) {
        try {
          const content = fs.readFileSync(fp, "utf8");
          for (const pkg of extractAppPackages(content)) {
            if (!pkgMap.has(pkg)) pkgMap.set(pkg, []);
            pkgMap.get(pkg).push(fp);
          }
        } catch { /* skip unreadable */ }
      }

      if (opts.listApps) {
        console.log(`\nApps detected in ${absDir} (${logFiles.length} log files):\n`);
        if (!pkgMap.size) {
          console.log("  (none detected)");
        } else {
          for (const [pkg, files] of [...pkgMap.entries()].sort()) {
            console.log(`  ${pkg}  (${files.length} file${files.length !== 1 ? "s" : ""})`);
          }
        }
        console.log();
        process.exit(0);
      }

      // Resolve which files to read
      const appFilter  = opts.app ? opts.app.toLowerCase() : null;
      const pkgPats    = opts.pkgFilter
        ? opts.pkgFilter.split(",").map(p => p.trim().toLowerCase()).filter(Boolean)
        : [];
      const keywords   = opts.keywords
        ? opts.keywords.split(",").map(k => k.trim().toLowerCase()).filter(Boolean)
        : [];
      const dedup      = opts.dedup !== false; // commander flips --no-dedup to opts.dedup=false

      // Select target apps
      let targetApps = [...pkgMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      if (appFilter) {
        targetApps = targetApps.filter(([pkg]) => pkg.toLowerCase().includes(appFilter));
        if (!targetApps.length) {
          console.error(`No apps matching "${opts.app}" found.`);
          console.error("Use --list-apps to see available apps.");
          process.exit(1);
        }
      }

      // If no app filter and no pkg filter, use all log files directly
      const filesToRead = appFilter
        ? [...new Set(targetApps.flatMap(([, files]) => files))]
        : logFiles;

      // Read + merge entries from selected files
      const allEntries  = [];
      const seenGlobal  = new Set();
      const appPackages = new Set();

      for (const fp of filesToRead) {
        try {
          const content = fs.readFileSync(fp, "utf8");
          for (const pkg of extractAppPackages(content)) appPackages.add(pkg);
          const entries = parseLogEntries(fp);
          for (const e of entries) {
            const dup = seenGlobal.has(e.key);
            allEntries.push({ ...e, duplicate: dup, sourceFile: path.basename(fp) });
            seenGlobal.add(e.key);
          }
        } catch { /* skip */ }
      }

      // Apply filters
      let filtered = allEntries;
      if (dedup)        filtered = filtered.filter(e => !e.duplicate);
      if (pkgPats.length) filtered = filtered.filter(e => entryMatchesPkg(e, pkgPats));
      if (keywords.length) filtered = filtered.filter(e => keywords.some(q => entryMatchesQuery(e, q)));

      // Print results grouped by app
      const appsToShow = appFilter
        ? targetApps.map(([pkg]) => pkg)
        : [...appPackages].sort();

      // Pre-compute per-app entries so we can count apps with matches
      let appsWithEntries = 0;
      let appGroups = [];  // { pkg, entries }

      if (appsToShow.length) {
        const knownLows = new Set(appsToShow.map(p => p.toLowerCase()));
        for (const pkg of appsToShow) {
          const pkgLow = pkg.toLowerCase();
          const appEntries = filtered.filter(e => {
            const cls = (e.className || e.sig || "").toLowerCase();
            return cls.includes(pkgLow);
          });
          if (appEntries.length > 0) appsWithEntries++;
          appGroups.push({ pkg, entries: appEntries });
        }

        // Unattributed entries
        const unattr = filtered.filter(e => {
          const cls = (e.className || e.sig || "").toLowerCase();
          return ![...knownLows].some(p => cls.includes(p));
        });
        if (unattr.length) appGroups.push({ pkg: null, entries: unattr });
      }

      const appsLabel = appsToShow.length
        ? `  |  Apps with matches: ${appsWithEntries} / ${appsToShow.length}`
        : "";

      console.log(`\nLog directory: ${absDir}`);
      console.log(`Log files: ${filesToRead.length}  |  Entries: ${filtered.length}  (dedup: ${dedup})${appsLabel}\n`);

      if (!appsToShow.length) {
        // No app package info — just print all entries
        console.log("=== Entries ===");
        for (const e of filtered) console.log(formatEntry(e));
      } else {
        for (const { pkg, entries } of appGroups) {
          if (pkg === null) {
            console.log(`\n=== (unattributed) — ${entries.length} entries ===`);
            for (const e of entries) console.log(formatEntry(e));
          } else {
            if (!entries.length && appFilter) continue;
            const uniqueCount = new Set(entries.map(e => e.key)).size;
            console.log(`\n=== ${pkg} — ${entries.length} call(s), ${uniqueCount} unique ===`);
            for (const e of entries) console.log(formatEntry(e));
          }
        }
      }

      console.log();

      // FSM image popup
      if (opts.fsm !== undefined) {
        const imgArg = typeof opts.fsm === "string" ? opts.fsm : null;
        const imgPath = imgArg
          ? path.resolve(imgArg.replace(/^~/, os.homedir()))
          : path.resolve(__dirname, "../../model.png");

        if (!fs.existsSync(imgPath)) {
          console.warn(`FSM image not found: ${imgPath}`);
        } else {
          const viewer = openImageViewer(imgPath);
          if (viewer) {
            console.log(`FSM image opened with ${viewer}: ${imgPath}`);
          } else {
            console.warn("No image viewer found. Install eog, feh, or xdg-open.");
          }
        }
      }
    });
}

module.exports = { register };
