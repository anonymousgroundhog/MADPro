/**
 * commands/log-view.js
 * `madpro log-view` — scan log dir, filter by app/keywords, print results,
 *   optionally pop up FSM model image.
 */

"use strict";

const path      = require("path");
const fs        = require("fs");
const os        = require("os");
const readline  = require("readline");
const { spawn } = require("child_process");

const NATIVELOADER_PKG_RE = /\/data\/app\/~~[^/]+\/([a-zA-Z][a-zA-Z0-9_.]*)-[A-Za-z0-9_]+=+=\//g;

// FNV-1a 32-bit
function fnv32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

// Fixed 2MB bitset — 2^24 slots
const BITSET_BITS = 1 << 24;
function makeBitset() { return new Uint32Array(BITSET_BITS >>> 5); }
function bitsetHas(bs, h) {
  const idx = (h >>> 0) % BITSET_BITS;
  return (bs[idx >>> 5] & (1 << (idx & 31))) !== 0;
}
function bitsetAdd(bs, h) {
  const idx = (h >>> 0) % BITSET_BITS;
  bs[idx >>> 5] |= (1 << (idx & 31));
}

function extractAppPackagesFromLine(line, found) {
  NATIVELOADER_PKG_RE.lastIndex = 0;
  let m;
  while ((m = NATIVELOADER_PKG_RE.exec(line)) !== null) found.add(m[1]);
}

const MARKER = "Entering: ";
const SIG_RE = /^<(.+):\s+(\S+)\s+([^(]+)\(([^)]*)\)>$/;

function entryMatchesQuery(methodName, sig, queryLow) {
  if (methodName) {
    if (methodName.toLowerCase().includes(queryLow)) return true;
  }
  return sig ? sig.toLowerCase().includes(queryLow) : false;
}

function entryMatchesPkg(className, sig, pkgPatterns) {
  const cls = (className || sig || "").toLowerCase();
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

/**
 * Stream one file. Filters applied inline — only matching entries returned.
 * Dedup is per-file only (same semantics as web UI).
 */
function scanFileStream(absPath, { dedup, pkgPats, keywords }) {
  return new Promise((resolve, reject) => {
    const pkgs    = new Set();
    const matches = [];
    const seenLocal = makeBitset(); // per-file dedup only

    const rl = readline.createInterface({
      input:     fs.createReadStream(absPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    rl.on("line", line => {
      extractAppPackagesFromLine(line, pkgs);

      const idx = line.indexOf(MARKER);
      if (idx === -1) return;

      const sig = line.slice(idx + MARKER.length).trim();
      const m   = SIG_RE.exec(sig);

      let className, returnType, methodName, args, key;
      if (m) {
        className  = m[1].trim();
        returnType = m[2].trim();
        methodName = m[3].trim();
        args       = m[4].trim();
        key        = `${className}#${methodName}(${args})`;
      } else {
        className = null; returnType = null; methodName = null; args = null;
        key = sig;
      }

      const h        = fnv32(key);
      const localDup = bitsetHas(seenLocal, h);
      bitsetAdd(seenLocal, h);

      if (dedup && localDup) return;

      // Package filter
      if (pkgPats.length && !entryMatchesPkg(className, sig, pkgPats)) return;

      // Keyword filter
      if (keywords.length && !keywords.some(q => entryMatchesQuery(methodName, sig, q))) return;

      matches.push({ className, returnType, methodName, args, sig, key, duplicate: localDup });
    });

    rl.on("close", () => resolve({ pkgs, matches }));
    rl.on("error", reject);
  });
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
    .action(async (dir, opts) => {
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

      const appFilter = opts.app ? opts.app.toLowerCase() : null;
      const pkgPats   = opts.pkgFilter
        ? opts.pkgFilter.split(",").map(p => p.trim().toLowerCase()).filter(Boolean)
        : [];
      const keywords  = opts.keywords
        ? opts.keywords.split(",").map(k => k.trim().toLowerCase()).filter(Boolean)
        : [];
      const dedup     = opts.dedup !== false;

      const pkgMap     = new Map(); // pkg → Set of filePaths
      const fileMap    = new Map(); // filePath → Set of pkgs (reverse of pkgMap)
      const allEntries = [];        // only matched entries
      const allPkgs    = new Set();

      let processed = 0;
      for (const fp of logFiles) {
        try {
          const { pkgs, matches } = await scanFileStream(fp, { dedup, pkgPats, keywords });

          for (const pkg of pkgs) {
            allPkgs.add(pkg);
            if (!pkgMap.has(pkg)) pkgMap.set(pkg, new Set());
            pkgMap.get(pkg).add(fp);
          }
          if (pkgs.size) {
            fileMap.set(fp, pkgs);
          }

          for (const e of matches) {
            allEntries.push({ ...e, sourceFile: fp, sourceBasename: path.basename(fp) });
          }
        } catch { /* skip unreadable */ }

        processed++;
        if (processed % 50 === 0) {
          process.stderr.write(`\rScanned ${processed}/${logFiles.length} files...`);
        }
      }
      if (logFiles.length >= 50) process.stderr.write("\r" + " ".repeat(40) + "\r");

      if (opts.listApps) {
        console.log(`\nApps detected in ${absDir} (${logFiles.length} log files):\n`);
        if (!pkgMap.size) {
          console.log("  (none detected)");
        } else {
          for (const [pkg, files] of [...pkgMap.entries()].sort()) {
            console.log(`  ${pkg}  (${files.size} file${files.size !== 1 ? "s" : ""})`);
          }
        }
        console.log();
        process.exit(0);
      }

      let targetApps = [...pkgMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      if (appFilter) {
        targetApps = targetApps.filter(([pkg]) => pkg.toLowerCase().includes(appFilter));
        if (!targetApps.length) {
          console.error(`No apps matching "${opts.app}" found.`);
          console.error("Use --list-apps to see available apps.");
          process.exit(1);
        }
      }

      const filtered   = allEntries;
      const appsToShow = appFilter
        ? targetApps.map(([pkg]) => pkg)
        : [...allPkgs].sort();

      let appsWithEntries = 0;
      const appGroups = [];

      if (appsToShow.length) {
        // Group entries by source file, then attribute to apps via fileMap.
        // An entry belongs to all apps detected in its source file.
        const appEntryMap = new Map(); // pkg → entries[]
        for (const pkg of appsToShow) appEntryMap.set(pkg, []);

        const unattr = [];
        for (const e of filtered) {
          const filePkgs = fileMap.get(e.sourceFile);
          if (!filePkgs || !filePkgs.size) {
            unattr.push(e);
            continue;
          }
          let attributed = false;
          for (const pkg of filePkgs) {
            if (appEntryMap.has(pkg)) {
              appEntryMap.get(pkg).push(e);
              attributed = true;
            }
          }
          if (!attributed) unattr.push(e);
        }

        for (const pkg of appsToShow) {
          const entries = appEntryMap.get(pkg);
          if (entries.length > 0) appsWithEntries++;
          appGroups.push({ pkg, entries });
        }
        if (unattr.length) appGroups.push({ pkg: null, entries: unattr });
      }

      const appsLabel = appsToShow.length
        ? `  |  Apps with matches: ${appsWithEntries} / ${appsToShow.length}`
        : "";

      console.log(`\nLog directory: ${absDir}`);
      console.log(`Log files: ${logFiles.length}  |  Entries: ${filtered.length}  (dedup: ${dedup})${appsLabel}\n`);

      if (!appsToShow.length) {
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

      if (opts.fsm !== undefined) {
        const imgArg  = typeof opts.fsm === "string" ? opts.fsm : null;
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
