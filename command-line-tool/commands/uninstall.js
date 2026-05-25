/**
 * commands/uninstall.js
 * `madpro uninstall` — bulk uninstall by category or by Play Store installer.
 */

const { spawnSync } = require("child_process");
const { findAdb } = require("../lib/tools");
const SEEDS = require("../lib/seeds");

async function resolvePkgs(categories, count) {
  const seen = new Set();
  const pkgs = [];
  for (const catId of categories) {
    const list = SEEDS[catId] || [];
    for (const p of list.slice(0, count)) {
      if (!seen.has(p)) { seen.add(p); pkgs.push(p); }
    }
  }
  return pkgs;
}

function register(program) {
  // Uninstall by category seed list
  program
    .command("uninstall")
    .description("Uninstall apps for given categories via adb")
    .option("-c, --categories <list>", "Comma-separated categories", "GAME_ACTION")
    .option("-n, --count <n>", "Apps per category", "10")
    .option("-d, --device <serial>", "ADB device serial")
    .action(async opts => {
      const adb = findAdb() || "adb";
      const serialArgs = opts.device ? ["-s", opts.device] : [];
      const categories = opts.categories.split(",").map(s => s.trim().toUpperCase());
      const count = parseInt(opts.count, 10);

      const pkgs = await resolvePkgs(categories, count);
      if (!pkgs.length) { console.log("[WARN] No packages resolved."); return; }
      console.log(`[INFO] Attempting uninstall of ${pkgs.length} package(s) on device ${opts.device || "(default)"}`);

      let removed = 0, skipped = 0, failed = 0;
      for (const pkg of pkgs) {
        const probe = spawnSync(adb, [...serialArgs, "shell", "pm", "path", "--user", "0", pkg], { encoding: "utf8", timeout: 10000 });
        if (!(probe.stdout || "").includes("package:")) {
          console.log(`[SKIP] ${pkg} (not installed)`);
          skipped++;
          continue;
        }
        const r = spawnSync(adb, [...serialArgs, "uninstall", pkg], { encoding: "utf8", timeout: 30000 });
        const out = (r.stdout || "") + (r.stderr || "");
        if (/^Success/i.test(out.trim())) {
          console.log(`[OK] Uninstalled ${pkg}`);
          removed++;
        } else {
          console.log(`[FAIL] ${pkg}: ${out.trim() || "exit " + r.status}`);
          failed++;
        }
      }
      console.log(`[DONE] removed=${removed} skipped=${skipped} failed=${failed} of ${pkgs.length}`);
    });

  // Uninstall all Play Store-installed apps on device
  program
    .command("uninstall-playstore")
    .description("Uninstall all Play Store-installed apps via adb")
    .option("-d, --device <serial>", "ADB device serial")
    .action(async opts => {
      const adb = findAdb() || "adb";
      const serialArgs = opts.device ? ["-s", opts.device] : [];

      console.log(`[INFO] Querying Play Store-installed packages on device ${opts.device || "(default)"}...`);
      const list = spawnSync(adb, [...serialArgs, "shell", "pm", "list", "packages", "-i"], { encoding: "utf8", timeout: 30000 });
      if (list.error) { console.error(`[ERROR] adb failed: ${list.error.message}`); process.exit(1); }

      const pkgs = [];
      for (const line of (list.stdout || "").split("\n")) {
        if (!line.includes("installer=com.android.vending")) continue;
        const m = line.match(/^package:(\S+)/);
        if (m) pkgs.push(m[1]);
      }

      if (!pkgs.length) { console.log("[WARN] No Play Store-installed packages found."); return; }
      console.log(`[INFO] Found ${pkgs.length} Play Store package(s). Uninstalling...`);

      let removed = 0, failed = 0;
      for (const pkg of pkgs) {
        const r = spawnSync(adb, [...serialArgs, "uninstall", pkg], { encoding: "utf8", timeout: 30000 });
        const out = (r.stdout || "") + (r.stderr || "");
        if (/^Success/i.test(out.trim())) {
          console.log(`[OK] Uninstalled ${pkg}`);
          removed++;
        } else {
          console.log(`[FAIL] ${pkg}: ${out.trim() || "exit " + r.status}`);
          failed++;
        }
      }
      console.log(`[DONE] removed=${removed} failed=${failed} of ${pkgs.length}`);
    });
}

module.exports = { register };
