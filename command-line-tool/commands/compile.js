/**
 * commands/compile.js
 * `madpro compile` — compile LogInjector.java only.
 */

const { ensureCompiled } = require("./inject");

function register(program) {
  program
    .command("compile")
    .description("Compile LogInjector.java (required before injection)")
    .option("--force", "Force recompile even if .class already exists", false)
    .action(async opts => {
      const ok = await ensureCompiled(opts.force);
      process.exit(ok ? 0 : 1);
    });
}

module.exports = { register };
