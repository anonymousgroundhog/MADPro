/**
 * commands/reset-failed.js
 * `madpro reset-failed` — delete .skip_list.json files so previously-failed
 * or skipped packages are retried on the next google-play download run.
 */

const path = require("path");
const fs = require("fs");

const SKIP_FILE = ".skip_list.json";

// Recursively find all .skip_list.json files under rootDir.
function findSkipLists(rootDir) {
  const results = [];
  function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name === SKIP_FILE) results.push(full);
    }
  }
  walk(rootDir, 0);
  return results;
}

function register(program) {
  program
    .command("reset-failed")
    .description("Delete .skip_list.json files so failed/skipped apps are retried on next google-play download")
    .argument("<output-dir>", "The same output directory passed to `madpro download`")
    .option("-c, --categories <list>", "Only reset specific categories (comma-separated). Omit to reset all.")
    .option("--list", "Print what would be deleted without actually deleting", false)
    .action((outputDir, opts) => {
      outputDir = path.resolve(outputDir);

      if (!fs.existsSync(outputDir)) {
        console.error(`ERROR: Directory not found: ${outputDir}`);
        process.exit(1);
      }

      const categories = opts.categories
        ? opts.categories.split(",").map(s => s.trim().toUpperCase())
        : null;

      // Narrow search root to category subdirs when --categories given
      const searchRoots = categories
        ? categories.map(c => path.join(outputDir, c, "google_play"))
        : [outputDir];

      const found = [];
      for (const root of searchRoots) {
        if (!fs.existsSync(root)) {
          if (categories) console.warn(`[WARN] No google_play dir found for: ${path.basename(path.dirname(root))}`);
          continue;
        }
        found.push(...findSkipLists(root));
      }

      if (!found.length) {
        console.log("No .skip_list.json files found — nothing to reset.");
        return;
      }

      console.log(`\nFound ${found.length} skip list file(s):\n`);
      for (const f of found) {
        // Show counts from the JSON before deleting
        let entries = 0;
        try {
          const data = JSON.parse(fs.readFileSync(f, "utf8"));
          entries = Object.keys(data).length;
        } catch {}
        const rel = path.relative(outputDir, f);
        console.log(`  ${rel}  (${entries} skipped package(s))`);
      }

      if (opts.list) {
        console.log("\n[DRY RUN] No files deleted. Remove --list to apply.");
        return;
      }

      console.log();
      let deleted = 0;
      let failed = 0;
      for (const f of found) {
        try {
          fs.unlinkSync(f);
          console.log(`  [OK] Deleted: ${path.relative(outputDir, f)}`);
          deleted++;
        } catch (err) {
          console.error(`  [ERROR] Could not delete ${f}: ${err.message}`);
          failed++;
        }
      }

      console.log(`\nReset complete: ${deleted} deleted, ${failed} failed.`);
      if (deleted > 0) {
        console.log("Run `madpro download -b google-play ...` to retry previously-skipped apps.");
      }
    });
}

module.exports = { register };
