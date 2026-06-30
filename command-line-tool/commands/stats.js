/**
 * commands/stats.js
 * `madpro stats` — pipeline status + Play Store metadata per app across
 *   original / injected / logs directories.
 */

"use strict";

const path     = require("path");
const fs       = require("fs");
const crypto   = require("crypto");
const readline = require("readline");
const { lookupMany } = require("../lib/playstore");

/** Stream-hash a file with sha256; returns hex string. Aborts after timeoutMs. */
function sha256File(filePath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    let settled  = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(val);
    };

    stream.on("data",  chunk => hash.update(chunk));
    stream.on("end",   ()    => done(null, hash.digest("hex")));
    stream.on("error", err  => done(err));
  });
}

// ── directory parsers ──────────────────────────────────────────────────────

/**
 * Parse original dir.
 * Layout A (apkpure / google_play):  <root>/<CATEGORY>/<source>/<pkg>/<pkg>/base.apk
 * Layout B (androzoo):               <root>/androzoo/<sha256>.apk  (filename IS the hash)
 *
 * Returns:
 *   result:       Map<pkg, { category, source, apkPath }>
 *   origHashMap:  Map<hash, pkg>  (androzoo — resolved later via hashToPkg from logs)
 */
function parseOriginalDir(rootDir) {
  const result      = new Map(); // pkg → { category, source, apkPath }
  const origHashMap = new Map(); // sha256 hash → { apkPath }  (androzoo only)
  if (!rootDir || !fs.existsSync(rootDir)) return { result, origHashMap };

  for (const catOrSource of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!catOrSource.isDirectory()) continue;
    const topName = catOrSource.name;
    const topPath = path.join(rootDir, topName);

    if (topName === "androzoo") {
      // flat — filename is sha256; pkg resolved later via hashToPkg
      for (const f of fs.readdirSync(topPath, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".apk")) continue;
        const hash = f.name.slice(0, -4);
        origHashMap.set(hash, { apkPath: path.join(topPath, f.name) });
      }
      continue;
    }

    // category folder — enumerate source subfolders
    for (const srcEntry of fs.readdirSync(topPath, { withFileTypes: true })) {
      if (!srcEntry.isDirectory()) continue;
      const srcName = srcEntry.name;
      const srcPath = path.join(topPath, srcName);
      for (const pkgEntry of fs.readdirSync(srcPath, { withFileTypes: true })) {
        if (!pkgEntry.isDirectory()) continue;
        const pkg = pkgEntry.name;
        if (!pkg.includes(".")) continue;
        // apkpure: <pkg>/<pkg>/base.apk  (double-nested)
        // google_play: <pkg>/base.apk    (single-nested)
        const apkDouble = path.join(srcPath, pkg, pkg, "base.apk");
        const apkSingle = path.join(srcPath, pkg, "base.apk");
        const apkPath   = fs.existsSync(apkDouble) ? apkDouble
                        : fs.existsSync(apkSingle) ? apkSingle
                        : null;
        let rec = result.get(pkg);
        if (!rec) {
          rec = { sources: new Set(), catBySource: new Map(), apkPath: null };
          result.set(pkg, rec);
        }
        rec.sources.add(srcName);
        if (!rec.catBySource.has(srcName)) rec.catBySource.set(srcName, new Set());
        rec.catBySource.get(srcName).add(topName);
        if (!rec.apkPath && apkPath) rec.apkPath = apkPath;
      }
    }
  }
  return { result, origHashMap };
}

/**
 * Parse injected dir.
 * Layout: <root>/<source>/<CATEGORY>_<source>_<pkg>[_<pkg>]/
 * For androzoo: <root>/androzoo/<hash>/  — pkg extracted from corresponding log.
 *
 * Returns Map<pkg, { category, source, injectedDir }>
 */
function parseInjectedDir(rootDir) {
  const result  = new Map();
  const hashMap = new Map(); // hash → injectedDir  (androzoo only)
  if (!rootDir || !fs.existsSync(rootDir)) return { result, hashMap };

  for (const srcEntry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!srcEntry.isDirectory()) continue;
    const source  = srcEntry.name; // apkpure | google_play | androzoo
    const srcPath = path.join(rootDir, source);

    for (const subEntry of fs.readdirSync(srcPath, { withFileTypes: true })) {
      if (!subEntry.isDirectory()) continue;
      const folderName = subEntry.name;
      const folderPath = path.join(srcPath, folderName);

      if (source === "androzoo") {
        // Hash-named folder; pkg resolved later from logs
        hashMap.set(folderName, { source, injectedDir: folderPath });
        continue;
      }

      const parsed = parseFolderName(folderName, source);
      if (!parsed) continue;
      const { pkg, category } = parsed;
      let rec = result.get(pkg);
      if (!rec) {
        rec = { sources: new Set(), catBySource: new Map(), injectedDir: folderPath };
        result.set(pkg, rec);
      }
      rec.sources.add(source);
      if (!rec.catBySource.has(source)) rec.catBySource.set(source, new Set());
      rec.catBySource.get(source).add(category);
    }
  }

  return { result, hashMap };
}

/**
 * Parse log dir.
 * Layout: <root>/<source>/<CATEGORY>_<source>_<pkg>[_<pkg>].log
 * Androzoo: <root>/androzoo/<hash>.log  (pkg in header line)
 *
 * Returns Map<pkg, { source, logPath, sootLines, category }>
 * Also resolves androzoo hashes → pkg via log header "=== ... | <pkg> ==="
 */
async function parseLogsDir(rootDir) {
  const result     = new Map(); // pkg → { source, logPath, sootLines, category }
  const hashToPkg  = new Map(); // hash → pkg  (androzoo)
  if (!rootDir || !fs.existsSync(rootDir)) return { result, hashToPkg };

  for (const srcEntry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!srcEntry.isDirectory()) continue;
    const source  = srcEntry.name;
    const srcPath = path.join(rootDir, source);

    for (const logEntry of fs.readdirSync(srcPath, { withFileTypes: true })) {
      if (!logEntry.isFile() || !logEntry.name.endsWith(".log")) continue;
      const baseName = logEntry.name.slice(0, -4); // strip .log
      const logPath  = path.join(srcPath, logEntry.name);

      if (source === "androzoo") {
        // Read header line to resolve pkg, count soot lines
        const { pkg, sootLines } = await readAndrozooLog(logPath);
        if (pkg) {
          hashToPkg.set(baseName, pkg);
          let rec = result.get(pkg);
          if (!rec) {
            rec = { sources: new Set(), catBySource: new Map(), logPath, sootLines: 0 };
            result.set(pkg, rec);
          }
          rec.sources.add(source);
          rec.sootLines = Math.max(rec.sootLines, sootLines);
        }
      } else {
        const parsed = parseFolderName(baseName, source);
        if (!parsed) continue;
        const { pkg, category } = parsed;
        const sootLines = await countSootLines(logPath);
        let rec = result.get(pkg);
        if (!rec) {
          rec = { sources: new Set(), catBySource: new Map(), logPath, sootLines: 0 };
          result.set(pkg, rec);
        }
        rec.sources.add(source);
        if (!rec.catBySource.has(source)) rec.catBySource.set(source, new Set());
        rec.catBySource.get(source).add(category);
        rec.sootLines = Math.max(rec.sootLines, sootLines);
      }
    }
  }

  return { result, hashToPkg };
}

/** Read first line of androzoo log to get pkg; count SootInjection lines. */
async function readAndrozooLog(logPath) {
  return new Promise(resolve => {
    let pkg       = null;
    let sootLines = 0;
    let linesDone = 0;

    const rl = readline.createInterface({
      input: fs.createReadStream(logPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    rl.on("line", line => {
      linesDone++;
      if (linesDone === 1) {
        // "=== 2026-06-27T00:36:58.475Z | com.firstchoice.myfirstchoice ==="
        const m = line.match(/===\s+[\dT:.Z-]+\s+\|\s+([a-zA-Z][a-zA-Z0-9_.]+)\s+===/);
        if (m) pkg = m[1];
      }
      if (line.includes("SootInjection")) sootLines++;
    });

    rl.on("close", () => resolve({ pkg, sootLines }));
    rl.on("error", () => resolve({ pkg: null, sootLines: 0 }));
  });
}

/** Count SootInjection lines in a log file (non-androzoo). */
async function countSootLines(logPath) {
  return new Promise(resolve => {
    let count = 0;
    const rl = readline.createInterface({
      input: fs.createReadStream(logPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", line => { if (line.includes("SootInjection")) count++; });
    rl.on("close", () => resolve(count));
    rl.on("error", () => resolve(0));
  });
}

/**
 * Parse folder/file base name like:
 *   ART_AND_DESIGN_apkpure_com_adobe_spark_post_com_adobe_spark_post
 *   BUSINESS_google_play_academy_gocrypto_trading
 *
 * Returns { pkg, category } or null.
 */
function parseFolderName(name, source) {
  // Match: <CATEGORY>_<source>_<rest>
  const re = new RegExp(`^(.+?)_(${source})_(.+)$`);
  const m  = name.match(re);
  if (!m) return null;

  const category = m[1];
  const rest     = m[3];
  const parts    = rest.split("_");
  const n        = parts.length;

  // Try to find pkg_pkg repetition (apkpure pattern)
  for (let i = 1; i < n; i++) {
    const left  = parts.slice(0, i).join("_");
    const right = parts.slice(i).join("_");
    if (left === right) {
      return { pkg: left.replace(/_/g, "."), category };
    }
  }

  // No repetition (google_play pattern): whole rest is pkg
  return { pkg: rest.replace(/_/g, "."), category };
}

// ── pipeline status ────────────────────────────────────────────────────────

/**
 * Determine pipeline status for a pkg.
 *   - "successfully_ran"     : log exists AND has >= 1 SootInjection line
 *   - "failed_to_run"        : log exists AND has 0 SootInjection lines
 *   - "successfully_compiled": injected dir exists, no log
 *   - "not_compiled"         : only in original dir
 *   - "unknown"              : none of the above
 */
function pipelineStatus(pkg, { inOriginal, inInjected, inLogs, sootLines }) {
  if (inLogs) {
    return sootLines > 0 ? "successfully_ran" : "failed_to_run";
  }
  if (inInjected) return "successfully_compiled";
  if (inOriginal) return "not_compiled";
  return "unknown";
}

// ── output helpers ─────────────────────────────────────────────────────────

function padEnd(str, len) {
  str = String(str ?? "");
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function printTable(rows, headers, widths) {
  const divider = widths.map(w => "-".repeat(w)).join("-+-");
  const header  = headers.map((h, i) => padEnd(h, widths[i])).join(" | ");
  console.log(header);
  console.log(divider);
  for (const row of rows) {
    console.log(row.map((c, i) => padEnd(c, widths[i])).join(" | "));
  }
}

function writeCSV(outPath, rows, headers) {
  const escape = v => {
    v = String(v ?? "");
    if (v.includes(",") || v.includes('"') || v.includes("\n")) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };
  const lines = [
    headers.join(","),
    ...rows.map(r => r.map(escape).join(",")),
  ];
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
}

// ── command registration ───────────────────────────────────────────────────

function register(program) {
  program
    .command("stats")
    .description("Pipeline status + Play Store metadata for each discovered app")
    .option("--original-dir <path>",  "Directory containing original APKs")
    .option("--injected-dir <path>",  "Directory containing injected APKs")
    .option("--logs-dir <path>",      "Directory containing execution logs")
    .option("--no-play-store",        "Skip Play Store lookups (faster)")
    .option("--csv <file>",           "Also write results to CSV file")
    .option("--pkg <pattern>",        "Filter to packages matching pattern (partial)")
    .option("--status <s>",           "Filter by status: successfully_ran|failed_to_run|successfully_compiled|not_compiled")
    .option("--concurrency <n>",      "Play Store fetch concurrency (default: 3)", "3")
    .action(async (opts) => {
      const originalDir = opts.originalDir
        ? path.resolve(opts.originalDir.replace(/^~/, require("os").homedir()))
        : null;
      const injectedDir = opts.injectedDir
        ? path.resolve(opts.injectedDir.replace(/^~/, require("os").homedir()))
        : null;
      const logsDir = opts.logsDir
        ? path.resolve(opts.logsDir.replace(/^~/, require("os").homedir()))
        : null;

      if (!originalDir && !injectedDir && !logsDir) {
        console.error("Provide at least one of --original-dir, --injected-dir, --logs-dir.");
        process.exit(1);
      }

      // ── scan all three dirs ──
      process.stderr.write("Scanning original dir...\n");
      const { result: origMap, origHashMap } = parseOriginalDir(originalDir);

      process.stderr.write("Scanning injected dir...\n");
      const { result: injMap, hashMap: injHashMap } = parseInjectedDir(injectedDir);

      process.stderr.write("Scanning logs dir (reading headers + counting SootInjection lines)...\n");
      const { result: logMap, hashToPkg } = await parseLogsDir(logsDir);

      // Resolve androzoo hashes → pkg in injected dir (adds androzoo source label)
      for (const [hash, meta] of injHashMap) {
        const pkg = hashToPkg.get(hash);
        if (!pkg) continue;
        let rec = injMap.get(pkg);
        if (!rec) {
          rec = { sources: new Set(), catBySource: new Map(), injectedDir: meta.injectedDir };
          injMap.set(pkg, rec);
        }
        rec.sources.add("androzoo");
      }
      // Resolve androzoo originals → pkg; build pkg → sha256 (hash IS the filename)
      // and tag the pkg with the androzoo source label in origMap.
      const androzooSha = new Map(); // pkg → sha256
      for (const [hash, origMeta] of origHashMap) {
        const pkg = hashToPkg.get(hash);
        if (!pkg) continue;
        androzooSha.set(pkg, hash);
        let rec = origMap.get(pkg);
        if (!rec) {
          rec = { sources: new Set(), catBySource: new Map(), apkPath: origMeta.apkPath };
          origMap.set(pkg, rec);
        }
        rec.sources.add("androzoo");
      }

      // ── collect all unique packages ──
      const allPkgs = new Set([...origMap.keys(), ...injMap.keys(), ...logMap.keys()]);

      // ── build records ──
      // Each app appears in 1+ sources (apkpure / google_play / androzoo).
      // A pkg can live in multiple source dirs (376 cross-source dupes observed),
      // so `source` and `category` are aggregated across ALL discovered slots.
      let records = [];
      for (const pkg of [...allPkgs].sort()) {
        const origMeta = origMap.get(pkg) || null;
        const injMeta  = injMap.get(pkg)  || null;
        const logMeta  = logMap.get(pkg)  || null;

        const sootLines = logMeta?.sootLines ?? 0;
        const status    = pipelineStatus(pkg, {
          inOriginal: !!origMeta,
          inInjected: !!injMeta,
          inLogs:     !!logMeta,
          sootLines,
        });

        // Aggregate every source label this pkg carries across the three dirs.
        const sourceSet = new Set();
        // Aggregate categories per source. A pkg can appear under multiple
        // categories within the SAME source (e.g. com.discord in both
        // SOCIAL/google_play and COMMUNICATION/google_play), so each source
        // maps to a Set of categories.
        const catBySource = new Map(); // source → Set<category>
        for (const meta of [origMeta, injMeta, logMeta]) {
          if (!meta) continue;
          for (const s of (meta.sources || (meta.source ? [meta.source] : []))) {
            sourceSet.add(s);
          }
          if (meta.catBySource) {
            for (const [s, cats] of meta.catBySource) {
              if (!catBySource.has(s)) catBySource.set(s, new Set());
              for (const c of cats) if (c) catBySource.get(s).add(c);
            }
          }
        }

        const sources    = [...sourceSet].sort();
        const source      = sources.join(",") || null;
        // Flatten all (source, category) pairs. Render a single category when
        // there's exactly one distinct category overall; otherwise label each:
        // "apkpure:COMMUNICATION,google_play:COMMUNICATION,google_play:SOCIAL".
        const pairs = [];
        const allCats = new Set();
        for (const [s, cats] of [...catBySource.entries()].sort()) {
          for (const c of [...cats].sort()) { pairs.push(`${s}:${c}`); allCats.add(c); }
        }
        const category = allCats.size === 0 ? null
                       : allCats.size === 1 ? [...allCats][0]
                       : pairs.join(",");

        // sha256: androzoo filename IS the hash; apkpure/google_play computed later
        const knownSha = androzooSha.get(pkg) || null;
        const apkPath  = origMeta?.apkPath    || null;

        records.push({
          pkg, category, source, sources, status, sootLines,
          sha256: knownSha, apkPath,
          appName: null, rating: null, downloads: null, hasAds: null, storeCategory: null,
        });
      }

      // ── apply filters ──
      const pkgPat = opts.pkg ? opts.pkg.toLowerCase() : null;
      if (pkgPat) records = records.filter(r => r.pkg.toLowerCase().includes(pkgPat));
      if (opts.status) records = records.filter(r => r.status === opts.status);

      console.log(`\nTotal apps discovered: ${allPkgs.size}  |  After filters: ${records.length}\n`);
      if (!records.length) { console.log("No apps match filters."); return; }

      // ── SHA-256 hashing (apkpure / google_play only; androzoo already resolved) ──
      if (originalDir) {
        const hashCacheFile = path.join(require("os").tmpdir(), "madpro_sha256_cache.json");
        let hashCache = {};
        try { hashCache = JSON.parse(fs.readFileSync(hashCacheFile, "utf8")); } catch { /* cold start */ }

        const needHash = records.filter(r => !r.sha256 && r.apkPath);
        // Apply already-cached hashes first
        for (const r of needHash) {
          if (hashCache[r.apkPath]) r.sha256 = hashCache[r.apkPath];
        }
        const stillNeed = needHash.filter(r => !r.sha256);

        if (stillNeed.length) {
          process.stderr.write(`Computing SHA-256 for ${stillNeed.length} APKs...\n`);
          let hDone = 0;
          for (const r of stillNeed) {
            try {
              r.sha256 = await sha256File(r.apkPath, 30000);
              hashCache[r.apkPath] = r.sha256;
            } catch (e) {
              process.stderr.write(`\n  [WARN] ${path.basename(r.apkPath)}: ${e.message}\n`);
            }
            hDone++;
            if (hDone % 10 === 0 || hDone === stillNeed.length) {
              process.stderr.write(`\r  ${hDone}/${stillNeed.length} hashes done...`);
            }
            // Persist cache every 50 files
            if (hDone % 50 === 0) {
              try { fs.writeFileSync(hashCacheFile, JSON.stringify(hashCache), "utf8"); } catch { /* non-fatal */ }
            }
          }
          try { fs.writeFileSync(hashCacheFile, JSON.stringify(hashCache), "utf8"); } catch { /* non-fatal */ }
          process.stderr.write("\r" + " ".repeat(50) + "\r");
          process.stderr.write(`SHA-256 cache saved to ${hashCacheFile}\n`);
        }
      }

      // ── Play Store lookup ──
      if (opts.playStore !== false) {
        const { lookupPlayStore, clearCache } = require("../lib/playstore");
        const concur   = Math.max(1, parseInt(opts.concurrency, 10) || 3);
        const BATCH    = 100; // process 100 at a time, then GC
        const total    = records.length;
        let   done     = 0;

        // Disk cache to survive restarts
        const cacheFile = path.join(require("os").tmpdir(), "madpro_play_cache.json");
        let diskCache = {};
        try { diskCache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { /* cold start */ }

        process.stderr.write(`Fetching Play Store data for ${total} apps (concurrency=${concur}, batch=100)...\n`);

        for (let i = 0; i < records.length; i += BATCH) {
          const batch = records.slice(i, i + BATCH);

          // Lookup in parallel within batch (respecting concurrency)
          const queue = batch.filter(r => !diskCache[r.pkg]);
          let qi = 0;

          const spawnWorker = () => (async () => {
            while (qi < queue.length) {
              const r = queue[qi++];
              try {
                const pd = await lookupPlayStore(r.pkg);
                diskCache[r.pkg] = pd;
              } catch { diskCache[r.pkg] = { stillOnStore: false }; }
              done++;
              process.stderr.write(`\r  ${done}/${total} Play Store lookups done...`);
            }
          })();

          const wCount = Math.min(concur, Math.max(queue.length, 1));
          await Promise.all(Array.from({ length: wCount }, spawnWorker));

          // Apply to records in this batch
          for (const r of batch) {
            const pd = diskCache[r.pkg];
            if (pd && pd.stillOnStore) {
              r.appName       = pd.appName   ?? null;
              r.rating        = pd.rating    != null ? String(pd.rating) : null;
              r.downloads     = pd.downloads ?? null;
              r.hasAds        = pd.hasAds    != null ? (pd.hasAds ? "Yes" : "No") : null;
              r.storeCategory = pd.category  ?? null;
            }
          }

          // Persist cache to disk and clear in-memory module cache
          try { fs.writeFileSync(cacheFile, JSON.stringify(diskCache), "utf8"); } catch { /* non-fatal */ }
          clearCache(); // drop module-level CACHE Map between batches
        }

        process.stderr.write("\r" + " ".repeat(60) + "\r");
        process.stderr.write(`Play Store cache saved to ${cacheFile}\n`);
      }

      // ── build output rows ──
      const headers = [
        "Package", "SHA-256", "App Name", "Category", "Source",
        "Status", "Instrumented Method Calls", "Rating", "Downloads", "Has Ads",
      ];

      const rows = records.map(r => [
        r.pkg,
        r.sha256        ?? "",
        r.appName       ?? "",
        r.storeCategory ?? r.category ?? "",
        r.source        ?? "",
        r.status,
        String(r.sootLines),
        r.rating        ?? "",
        r.downloads     ?? "",
        r.hasAds        ?? "",
      ]);

      // ── ASCII table ──
      const widths = headers.map((h, i) =>
        Math.min(50, Math.max(h.length, ...rows.map(r => String(r[i] ?? "").length)))
      );
      printTable(rows, headers, widths);

      // ── CSV export ──
      if (opts.csv) {
        const csvPath = path.resolve(opts.csv);
        writeCSV(csvPath, rows, headers);
        console.log(`\nCSV written to: ${csvPath}`);
      }

      // ── summary ──
      const counts = {};
      for (const r of records) counts[r.status] = (counts[r.status] || 0) + 1;
      console.log("\nStatus summary:");
      for (const [s, n] of Object.entries(counts).sort()) {
        console.log(`  ${s}: ${n}`);
      }
      console.log();
    });
}

module.exports = { register };
