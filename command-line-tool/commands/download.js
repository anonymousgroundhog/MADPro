/**
 * commands/download.js
 * `madpro download` — download APKs via apkeep (ApkPure), Google Play, or Androzoo.
 */

const path = require("path");
const fs = require("fs");
const { findBin, findAdb } = require("../lib/tools");
const { run } = require("../lib/runner");
const { normalizeApksInDir, extractXapksInDir } = require("../lib/apk-utils");
const SEEDS = require("../lib/seeds");

const ALL_CATEGORIES = Object.keys(SEEDS);

async function fetchTopPackages(catId, count) {
  // Lightweight scrape — mirrors playstore.js in the dashboard.
  // Falls through quickly if network unavailable; caller merges with seeds.
  try {
    const playstore = require(path.join(__dirname, "../../apk-dashboard/playstore.js"));
    return await playstore.fetchTopPackages(catId, count);
  } catch {
    return [];
  }
}

async function resolveCategoryPackages(catId, count) {
  let pkgs = [];
  try {
    pkgs = await fetchTopPackages(catId, count);
    if (pkgs.length) console.log(`[INFO] ${catId}: scraped ${pkgs.length} pkg(s) from Play Store`);
  } catch (err) {
    console.warn(`[WARN] ${catId}: scrape failed — ${err.message}`);
  }
  const seeds = SEEDS[catId] || [];
  const seen = new Set(pkgs);
  for (const s of seeds) {
    if (pkgs.length >= count) break;
    if (!seen.has(s)) { pkgs.push(s); seen.add(s); }
  }
  if (pkgs.length < count) {
    console.warn(`[WARN] ${catId}: only ${pkgs.length}/${count} pkg(s) available`);
  }
  return pkgs.slice(0, count);
}

async function downloadApkPure(categories, count, outputDir, timeoutMs) {
  fs.mkdirSync(outputDir, { recursive: true });
  const apkeepBin = findBin("apkeep");
  if (!apkeepBin) {
    console.error("ERROR: apkeep not found. Install: cargo install apkeep");
    process.exit(1);
  }

  for (const catId of categories) {
    const packages = await resolveCategoryPackages(catId, count);
    if (!packages.length) { console.log(`[SKIP] No packages for ${catId}`); continue; }
    console.log(`\n--- Category: ${catId} (${packages.length} app(s)) ---`);

    const catDir = path.join(outputDir, catId, "apkpure");
    fs.mkdirSync(catDir, { recursive: true });

    for (const pkg of packages) {
      const pkgDir = path.join(catDir, pkg);
      if (fs.existsSync(pkgDir) && fs.readdirSync(pkgDir).length > 0) {
        console.log(`  [SKIP] ${pkg} (already downloaded)`);
        continue;
      }
      console.log(`  Downloading: ${pkg}`);
      fs.mkdirSync(pkgDir, { recursive: true });
      const ok = await run(apkeepBin, ["-a", pkg, "-d", "apk-pure", pkgDir], { timeoutMs });
      console.log(ok ? `  [OK] ${pkg}` : `  [FAILED] ${pkg}`);
    }
  }

  // Post-process: extract XAPKs + normalize names
  console.log("\n--- Processing downloaded files ---");
  for (const catId of categories) {
    const catDir = path.join(outputDir, catId, "apkpure");
    if (!fs.existsSync(catDir)) continue;
    extractXapksInDir(catDir);
    for (const e of fs.readdirSync(catDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(catDir, e.name);
      extractXapksInDir(p);
      normalizeApksInDir(p);
    }
  }
}

// Count how many packages in catDir already have at least one APK pulled.
function countPulled(catDir) {
  if (!fs.existsSync(catDir)) return 0;
  return fs.readdirSync(catDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .filter(e => {
      const d = path.join(catDir, e.name);
      return fs.readdirSync(d).some(f => f.toLowerCase().endsWith(".apk"));
    }).length;
}

async function downloadGPlay(categories, count, outputDir, deviceSerial, timeoutMs) {
  fs.mkdirSync(outputDir, { recursive: true });
  const pythonBin = findBin("python3") || findBin("python") || "python3";
  const bridgeScript = path.join(__dirname, "../../apk-dashboard/gplay_download.py");

  if (!fs.existsSync(bridgeScript)) {
    console.error(`ERROR: gplay_download.py not found at ${bridgeScript}`);
    process.exit(1);
  }

  const timeoutSec = timeoutMs > 0 ? Math.floor(timeoutMs / 1000) : 0;

  for (const catId of categories) {
    const catDir = path.join(outputDir, catId, "google_play");
    fs.mkdirSync(catDir, { recursive: true });

    // Phase 1: download known packages from seed/scrape list
    const packages = await resolveCategoryPackages(catId, count);

    if (packages.length > 0) {
      console.log(`\n--- Category: ${catId} — Phase 1: ${packages.length} known package(s) ---`);
      const args = [bridgeScript, deviceSerial || "", catDir, timeoutSec, ...packages];
      const ok = await run(pythonBin, args);
      if (!ok) console.warn(`[WARN] Some Phase 1 downloads may have failed for ${catId}`);
    }

    // Phase 2: count how many actually pulled; fill shortfall via category-browse
    const pulled = countPulled(catDir);
    const shortfall = count - pulled;

    if (shortfall > 0) {
      console.log(`\n--- Category: ${catId} — Phase 2: need ${shortfall} more (have ${pulled}/${count}) ---`);
      console.log(`[INFO] ${catId}: switching to Appium category-browse to collect ${shortfall} more app(s)...`);
      const args = [
        bridgeScript,
        "--browse-category", catId,
        "--count", String(shortfall),
        deviceSerial || "",
        catDir,
        String(timeoutSec),
      ];
      const ok = await run(pythonBin, args);
      if (!ok) console.warn(`[WARN] Category-browse mode failed or partially succeeded for ${catId}`);

      const finalPulled = countPulled(catDir);
      console.log(`[INFO] ${catId}: total downloaded = ${finalPulled}/${count}`);
    } else {
      console.log(`[INFO] ${catId}: target reached (${pulled}/${count}) — skipping category-browse`);
    }
  }

  console.log("\n--- Processing downloaded files ---");
  for (const catId of categories) {
    const catDir = path.join(outputDir, catId, "google_play");
    if (!fs.existsSync(catDir)) continue;
    extractXapksInDir(catDir);
    for (const e of fs.readdirSync(catDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(catDir, e.name);
      extractXapksInDir(p);
      normalizeApksInDir(p);
    }
  }
}

async function downloadAndrozoo(outputDir, apiKey, sha256Hashes, timeoutMs) {
  const androzooDir = path.join(outputDir, "androzoo");
  fs.mkdirSync(androzooDir, { recursive: true });
  const curlBin = findBin("curl");
  if (!curlBin) {
    console.error("ERROR: curl not found");
    process.exit(1);
  }

  const apiUrl = "https://androzoo.uni.lu/api/download";
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < sha256Hashes.length; i++) {
    const sha256 = sha256Hashes[i].trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      console.log(`  [SKIP] Invalid SHA256: ${sha256}`);
      failCount++;
      continue;
    }

    const outputFile = path.join(androzooDir, `${sha256}.apk`);
    if (fs.existsSync(outputFile)) {
      console.log(`  [SKIP] ${sha256.substring(0, 8)}... (already exists)`);
      successCount++;
      continue;
    }

    console.log(`Downloading [${i + 1}/${sha256Hashes.length}]: ${sha256.substring(0, 8)}...`);
    const requestUrl = `${apiUrl}?apikey=${encodeURIComponent(apiKey)}&sha256=${encodeURIComponent(sha256)}`;
    const ok = await run(curlBin, ["-s", "-w", "\n%{http_code}", "-H", "User-Agent: Mozilla/5.0 (Linux; Android 11)", "-o", outputFile, requestUrl], { timeoutMs });

    if (!fs.existsSync(outputFile)) {
      console.log(`  [FAILED] ${sha256.substring(0, 8)}... (no response)`);
      failCount++;
      continue;
    }

    const fileSize = fs.statSync(outputFile).size;
    let isError = false;
    try {
      const first500 = fs.readFileSync(outputFile, "utf8").substring(0, 500);
      if (first500.includes('{"error') || first500.includes("<html")) isError = true;
    } catch {}

    if (!isError && fileSize > 500 * 1024) {
      console.log(`  [OK] ${sha256.substring(0, 8)}... (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);
      successCount++;
    } else {
      fs.unlinkSync(outputFile);
      console.log(`  [FAILED] ${sha256.substring(0, 8)}... (${isError ? "API error" : `invalid size: ${fileSize}B`})`);
      failCount++;
    }
  }

  console.log(`\n--- Summary: ${successCount} successful, ${failCount} failed ---`);
}

function register(program) {
  const cmd = program
    .command("download")
    .description("Download APKs from ApkPure, Google Play, or Androzoo")
    .option("-b, --backend <name>", "apkpure | google-play | androzoo", "apkpure")
    .option("-c, --categories <list>", `Comma-separated categories. Available: ${ALL_CATEGORIES.join(", ")}`, "GAME_ACTION")
    .option("-n, --count <n>", "Apps per category", "5")
    .option("-o, --output <dir>", "Output directory", "./apks")
    .option("-d, --device <serial>", "ADB device serial (google-play only)")
    .option("-t, --timeout <ms>", "Per-download timeout in ms (0=none)", "0")
    .option("--api-key <key>", "Androzoo API key")
    .option("--sha256 <hashes>", "Comma-separated SHA256 hashes (Androzoo)")
    .action(async opts => {
      const backend    = opts.backend;
      const categories = opts.categories.split(",").map(s => s.trim().toUpperCase());
      const count      = parseInt(opts.count, 10);
      const outputDir  = path.resolve(opts.output);
      const timeoutMs  = parseInt(opts.timeout, 10);

      console.log(`\nBackend : ${backend}`);
      console.log(`Output  : ${outputDir}`);

      if (backend === "androzoo") {
        if (!opts.apiKey) { console.error("ERROR: --api-key required for androzoo"); process.exit(1); }
        const hashes = (opts.sha256 || "").split(",").map(s => s.trim()).filter(Boolean);
        if (!hashes.length) { console.error("ERROR: --sha256 required for androzoo"); process.exit(1); }
        await downloadAndrozoo(outputDir, opts.apiKey, hashes, timeoutMs);
      } else if (backend === "google-play") {
        await downloadGPlay(categories, count, outputDir, opts.device, timeoutMs);
      } else {
        await downloadApkPure(categories, count, outputDir, timeoutMs);
      }

      console.log("\nDone.");
    });
}

module.exports = { register };
