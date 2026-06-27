/**
 * commands/categories.js
 * `madpro categories` — list all Google Play category IDs and display names.
 */

const { PLAY_CATEGORIES } = require("../lib/play-categories");

function register(program) {
  program
    .command("categories")
    .description("List all Google Play category IDs usable with the download command")
    .option("--ids-only", "Print only the category IDs (one per line)")
    .action(opts => {
      if (opts.idsOnly) {
        for (const [id] of PLAY_CATEGORIES) console.log(id);
        return;
      }

      const games = PLAY_CATEGORIES.filter(([id]) => id.startsWith("GAME_"));
      const apps  = PLAY_CATEGORIES.filter(([id]) => !id.startsWith("GAME_"));

      console.log("\nGoogle Play Categories\n");

      console.log("  Games:");
      for (const [id, name] of games) {
        console.log(`    ${id.padEnd(24)}  ${name}`);
      }

      console.log("\n  Apps:");
      for (const [id, name] of apps) {
        console.log(`    ${id.padEnd(24)}  ${name}`);
      }

      console.log(`\n  Total: ${PLAY_CATEGORIES.length} categories`);
      console.log(`\n  Use --ids-only to print IDs for scripting.`);
      console.log(`  Pass any ID to: madpro download -c <ID> -n 5\n`);
    });
}

module.exports = { register };
