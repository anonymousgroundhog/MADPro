/**
 * commands/inject.js
 * `madpro inject` — log injection via LogInjector + zipalign/apksigner.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");
const { findBin, findAndroidPlatforms, findBuildTool, JAR_LIBS_DIR, JAVA_SRC_DIR, INJECTOR_CLASS } = require("../lib/tools");
const { run } = require("../lib/runner");
const { scanApks } = require("../lib/scanner");
const { extractXapksInDir, normalizeApksInDir } = require("../lib/apk-utils");

// Simple glob match: supports * (any segment chars) and ** (any path chars).
function matchGlob(glob, str) {
  const re = new RegExp(
    "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*\*/g, "\x00")
              .replace(/\*/g, "[^/]*")
              .replace(/\x00/g, ".*") + "$"
  );
  return re.test(str) || str.includes(glob.replace(/\*/g, ""));
}

async function ensureCompiled(forceRecompile = false) {
  const INJECTOR_SRC = path.join(JAVA_SRC_DIR, "LogInjector.java");

  if (fs.existsSync(INJECTOR_CLASS) && !forceRecompile) {
    // Recompile automatically if source is newer than class file
    try {
      const srcMtime   = fs.statSync(INJECTOR_SRC).mtimeMs;
      const classMtime = fs.statSync(INJECTOR_CLASS).mtimeMs;
      if (srcMtime > classMtime) {
        console.log("[INFO] LogInjector.java is newer than .class — recompiling...");
      } else {
        console.log("[INFO] LogInjector already compiled and up-to-date.");
        return true;
      }
    } catch {
      console.log("[INFO] LogInjector already compiled.");
      return true;
    }
  }

  if (!fs.existsSync(INJECTOR_SRC)) {
    console.error(`ERROR: LogInjector.java not found at ${INJECTOR_SRC}`);
    return false;
  }

  if (!fs.existsSync(JAR_LIBS_DIR)) {
    console.error(`ERROR: jar_libs dir not found at ${JAR_LIBS_DIR}`);
    return false;
  }

  const jars = fs.readdirSync(JAR_LIBS_DIR)
    .filter(f => f.endsWith(".jar"))
    .map(f => path.join(JAR_LIBS_DIR, f))
    .join(":");

  const javacBin = findBin("javac") || "javac";
  console.log("--- Compiling LogInjector.java ---");
  const ok = await run(javacBin, ["-cp", jars, "-d", JAVA_SRC_DIR, INJECTOR_SRC]);
  console.log(ok ? "[OK] Compiled." : "[ERROR] Compilation failed — check Java is installed.");
  return ok;
}

async function signOutputApks(outputDir) {
  const zipalign  = findBuildTool("zipalign");
  const apksigner = findBuildTool("apksigner");
  if (!zipalign || !apksigner) {
    console.warn("[WARN] zipalign/apksigner not found — skipping signing.");
    return;
  }

  const debugKeystore = path.join(os.homedir(), ".android", "debug.keystore");
  if (!fs.existsSync(debugKeystore)) {
    console.log("[INFO] Generating debug keystore…");
    spawnSync("keytool", [
      "-genkeypair", "-v", "-keystore", debugKeystore,
      "-alias", "androiddebugkey", "-keyalg", "RSA", "-keysize", "2048",
      "-validity", "10000", "-storepass", "android", "-keypass", "android",
      "-dname", "CN=Android Debug,O=Android,C=US",
    ], { encoding: "utf8" });
  }

  function findApks(dir) {
    let r = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) r = r.concat(findApks(full));
      else if (e.name.toLowerCase().endsWith(".apk")) r.push(full);
    }
    return r;
  }

  const apks = findApks(outputDir);
  if (!apks.length) { console.log("[INFO] No APKs to sign."); return; }

  for (const apk of apks) {
    if (apk.endsWith("-aligned.apk") || apk.endsWith("-signed.apk")) continue;
    const aligned = apk.replace(/\.apk$/, "-aligned.apk");
    console.log(`  Signing: ${path.basename(apk)}`);

    const zOk = await run(zipalign, ["-f", "-v", "4", apk, aligned]);
    if (!zOk) { console.warn(`  [WARN] zipalign failed for ${path.basename(apk)}`); continue; }

    const sOk = await run(apksigner, [
      "sign", "--ks", debugKeystore,
      "--ks-pass", "pass:android",
      "--ks-key-alias", "androiddebugkey",
      "--key-pass", "pass:android",
      "--out", apk, aligned,
    ]);
    try { fs.unlinkSync(aligned); } catch {}
    console.log(sOk ? `  [OK] Signed: ${path.basename(apk)}` : `  [WARN] apksigner failed for ${path.basename(apk)}`);
  }
}

function register(program) {
  program
    .command("inject")
    .description("Inject logging into APKs via LogInjector (Soot)")
    .argument("<apk-dir>", "Directory containing APKs to inject")
    .option("-b, --backend <name>", "apkpure | google-play | androzoo (scopes scan to backend subdirectory; apkpure also extracts XAPKs first)")
    .option("-o, --output <dir>", "Output directory for injected APKs", "./injected")
    .option("-p, --patterns <csv>", "Comma-separated method class filter patterns passed to LogInjector (empty = all)", "")
    .option("--pkg-filter <globs>", "Comma-separated glob patterns to select which APKs to inject by path/label (e.g. '*/SOCIAL/*,*/FINANCE/*')", "")
    .option("--inject-all", "Inject all methods (no filter)", false)
    .option("--force-compile", "Force recompile LogInjector.java", false)
    .action(async (apkDir, opts) => {
      const outputDir  = path.resolve(opts.output);
      const patterns   = opts.patterns ? opts.patterns.split(",").map(s => s.trim()).filter(Boolean) : [];
      const pkgFilters = opts.pkgFilter ? opts.pkgFilter.split(",").map(s => s.trim()).filter(Boolean) : [];
      const injectAll  = opts.injectAll;
      const backend    = opts.backend || null;

      // For apkpure: extract XAPKs across all category subdirs before scanning
      if (backend === "apkpure") {
        const resolvedApkDir = path.resolve(apkDir);
        for (const entry of fs.readdirSync(resolvedApkDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const catDir = path.join(resolvedApkDir, entry.name, "apkpure");
          if (!fs.existsSync(catDir)) continue;
          extractXapksInDir(catDir);
          for (const sub of fs.readdirSync(catDir, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            const pkgDir = path.join(catDir, sub.name);
            extractXapksInDir(pkgDir);
            normalizeApksInDir(pkgDir);
          }
        }
      }

      const scanRoot = path.resolve(apkDir);

      // 1. Compile
      const compiled = await ensureCompiled(opts.forceCompile);
      if (!compiled) process.exit(1);

      // 2. Android platforms
      const platforms = findAndroidPlatforms();
      if (!platforms) {
        console.error("ERROR: Android platforms not found. Set ANDROID_HOME or install Android SDK.");
        process.exit(1);
      }
      console.log(`[INFO] Android platforms: ${platforms}`);

      // 3. Scan APKs (skip aapt — inject only needs file paths, not metadata)
      let targets;
      try { targets = scanApks(scanRoot, { skipAapt: true }); }
      catch (err) { console.error(`ERROR scanning ${scanRoot}: ${err.message}`); process.exit(1); }

      if (!targets.length) {
        console.log("No APKs found in the selected directory.");
        return;
      }

      // Apply APK-level path filter if --pkg-filter given
      if (pkgFilters.length) {
        const before = targets.length;
        targets = targets.filter(t =>
          pkgFilters.some(glob => matchGlob(glob, t.primaryApk) || matchGlob(glob, t.label))
        );
        console.log(`[INFO] --pkg-filter: ${targets.length} of ${before} APK(s) match.`);
        if (!targets.length) { console.log("No APKs matched the filter — nothing to inject."); return; }
      }

      console.log(`Found ${targets.length} APK target(s).`);
      fs.mkdirSync(outputDir, { recursive: true });

      // 4. Build classpath
      const jars = fs.readdirSync(JAR_LIBS_DIR)
        .filter(f => f.endsWith(".jar"))
        .map(f => path.join(JAR_LIBS_DIR, f));
      const cp = [JAVA_SRC_DIR, ...jars].join(":");

      // 5. Inject each target
      for (const target of targets) {
        console.log(`\n--- Injecting: ${target.label} ---`);
        console.log(`    Input : ${target.primaryApk}`);

        const appOutDir = path.join(outputDir, target.label.replace(/[^a-zA-Z0-9_-]/g, "_"));
        fs.mkdirSync(appOutDir, { recursive: true });
        console.log(`    Output: ${appOutDir}`);

        const filterCsv = patterns.join(",");
        const javaArgs = [
          "-Xmx4g", "-Xms512m", "-XX:+UseG1GC",
          "-XX:MaxGCPauseMillis=200", "-XX:SoftRefLRUPolicyMSPerMB=0",
          "-XX:StringTableSize=1000003",
          "-cp", cp, "LogInjector",
        ];
        if (injectAll) javaArgs.push("--inject-all");
        javaArgs.push(platforms, target.primaryApk, appOutDir);
        if (filterCsv) javaArgs.push(filterCsv);

        const javaBin = findBin("java") || "java";
        console.log(`    Cmd: ${javaBin} ${javaArgs.join(" ")}`);

        const ok = await run(javaBin, javaArgs, {
          timeoutMs: 10 * 60 * 1000,
          stuckMs:    2 * 60 * 1000,
          filterSoot: true,
        });

        if (ok) {
          console.log(`[OK] ${target.label} — output in ${appOutDir}`);
          // Copy split libs
          const splitLibs = target.apkFiles.filter(f => f !== target.primaryApk);
          for (const lib of splitLibs) {
            const dest = path.join(appOutDir, path.basename(lib));
            try {
              fs.copyFileSync(lib, dest);
              console.log(`  Copied split lib: ${path.basename(lib)}`);
            } catch (e) {
              console.warn(`  [WARN] Could not copy ${path.basename(lib)}: ${e.message}`);
            }
          }
          await signOutputApks(appOutDir);
        } else {
          console.log(`[FAILED] ${target.label}`);
        }
      }

      console.log("\nDone.");
    });
}

module.exports = { register, ensureCompiled, signOutputApks };
