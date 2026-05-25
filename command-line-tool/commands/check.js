/**
 * commands/check.js
 * `madpro check` — print tool availability status.
 */

const { checkTools } = require("../lib/tools");

function register(program) {
  program
    .command("check")
    .description("Check availability of required tools")
    .action(() => {
      const t = checkTools();
      const row = (name, ok, extra) => {
        const mark = ok ? "✓" : "✗";
        const line = `  [${mark}] ${name}`;
        console.log(extra ? `${line}  (${extra})` : line);
      };

      console.log("\nTool Status:");
      row("apkeep",            t.apkeep);
      row("java",              t.java);
      row("adb",               t.adb);
      row("apktool",           t.apktool);
      row("curl",              t.curl);
      row("zipalign",          t.zipalign);
      row("apksigner",         t.apksigner);
      row("Android platforms", t.platforms, t.platformsPath || "not found");
      row("jar_libs",          t.jarLibsExist);
      row("LogInjector.class", t.injectorCompiled);
      console.log();
    });
}

module.exports = { register };
