/**
 * commands/instrument.js
 * `madpro instrument` — install, grant permissions, launch, capture logcat, uninstall.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { findAdb } = require("../lib/tools");
const { run } = require("../lib/runner");

const DANGEROUS_PERMISSIONS = [
  "android.permission.CAMERA",
  "android.permission.READ_CONTACTS",
  "android.permission.WRITE_CONTACTS",
  "android.permission.READ_CALENDAR",
  "android.permission.WRITE_CALENDAR",
  "android.permission.READ_CALL_LOG",
  "android.permission.WRITE_CALL_LOG",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.RECORD_AUDIO",
  "android.permission.READ_PHONE_STATE",
  "android.permission.CALL_PHONE",
  "android.permission.READ_SMS",
  "android.permission.SEND_SMS",
  "android.permission.RECEIVE_SMS",
  "android.permission.BODY_SENSORS",
  "android.permission.ACCESS_WIFI_STATE",
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function streamLogcat(adb, serialArgs, pkg, logFile, durationMs) {
  return new Promise(resolve => {
    const pidResult = spawnSync(adb, [...serialArgs, "shell", "pidof", pkg], { encoding: "utf8" });
    const pid = pidResult.stdout.trim();
    const logcatArgs = pid
      ? [...serialArgs, "logcat", "--pid", pid, "-v", "time"]
      : [...serialArgs, "logcat", "-v", "time", "-s", "SootInjection:D"];

    const logStream = fs.createWriteStream(logFile, { flags: "a" });
    logStream.write(`=== ${new Date().toISOString()} | ${pkg} ===\n`);
    console.log(`[INFO] Streaming logcat → ${logFile}`);

    const proc = spawn(adb, logcatArgs);
    const timeout = setTimeout(() => proc.kill(), durationMs);

    const onLine = line => {
      if (line.trim()) {
        console.log(line.trim());
        logStream.write(line + "\n");
      }
    };

    proc.stdout.on("data", d => d.toString().split("\n").forEach(onLine));
    proc.stderr.on("data", d => d.toString().split("\n").forEach(onLine));
    proc.on("close", () => {
      clearTimeout(timeout);
      logStream.end();
      resolve();
    });
    proc.on("error", err => {
      clearTimeout(timeout);
      console.error("ERROR:", err.message);
      logStream.end();
      resolve();
    });
  });
}

function register(program) {
  program
    .command("instrument")
    .description("Install APKs, run with logcat capture, then uninstall")
    .argument("<apk-dir>", "Directory of injected APK subdirectories")
    .option("-l, --log-dir <dir>", "Where to save logcat files", path.join(os.homedir(), "MADPro_Logcat"))
    .option("-d, --device <serial>", "ADB device serial")
    .option("--duration <ms>", "Logcat capture duration per app in ms", "30000")
    .action(async (apkDir, opts) => {
      const adb = findAdb() || "adb";
      const serialArgs = opts.device ? ["-s", opts.device] : [];
      const logDir = path.resolve(opts.logDir.replace(/^~/, os.homedir()));
      const durationMs = parseInt(opts.duration, 10);

      fs.mkdirSync(logDir, { recursive: true });
      console.log(`[INFO] Logcat output: ${logDir}`);

      let subdirs;
      try {
        subdirs = fs.readdirSync(apkDir, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => path.join(apkDir, e.name))
          .sort();
      } catch (err) {
        console.error(`ERROR: Cannot read ${apkDir}: ${err.message}`);
        process.exit(1);
      }

      if (!subdirs.length) {
        console.log("[WARN] No subdirectories found.");
        return;
      }
      console.log(`[INFO] Found ${subdirs.length} app bundle(s).`);

      for (const bundleDir of subdirs) {
        const bundleName = path.basename(bundleDir);
        console.log(`\n====== ${bundleName} ======`);

        let apks;
        try {
          apks = fs.readdirSync(bundleDir)
            .filter(f => f.toLowerCase().endsWith(".apk"))
            .map(f => path.join(bundleDir, f))
            .sort();
        } catch { apks = []; }

        if (!apks.length) { console.log(`[SKIP] No APKs in ${bundleName}`); continue; }

        const baseApk = apks.find(p => path.basename(p).toLowerCase() === "base.apk") || apks[0];
        console.log(`[INFO] APKs: ${apks.map(p => path.basename(p)).join(", ")}`);

        // Resolve package name before install (needed for pre-install uninstall)
        let pkg = null;
        for (const tool of ["aapt2", "aapt"]) {
          try {
            const r = spawnSync(tool, ["dump", "badging", baseApk], { encoding: "utf8", timeout: 15000 });
            const m = (r.stdout || "").match(/^package: name='([^']+)'/m);
            if (m) { pkg = m[1]; break; }
          } catch {}
        }

        if (!pkg) { console.warn(`[WARN] Could not determine package name for ${bundleName} — skipping.`); continue; }

        // Uninstall any existing version to avoid signature mismatch.
        // System apps can't be fully uninstalled — use --user 0 to remove
        // the user-space install and fall back to disabling if that fails.
        const probeResult = spawnSync(adb, [...serialArgs, "shell", "pm", "path", "--user", "0", pkg], { encoding: "utf8", timeout: 10000 });
        if ((probeResult.stdout || "").includes("package:")) {
          console.log(`[INFO] Existing install of ${pkg} detected — uninstalling first...`);
          const uninstallResult = spawnSync(adb, [...serialArgs, "uninstall", pkg], { encoding: "utf8", timeout: 30000 });
          if (/^Success/i.test((uninstallResult.stdout || "").trim())) {
            console.log(`[OK] Uninstalled existing ${pkg}`);
          } else {
            // May be a system app — try removing user-space copy only
            console.log(`[INFO] Full uninstall failed — trying user-space removal...`);
            const userUninstall = spawnSync(adb, [...serialArgs, "shell", "pm", "uninstall", "--user", "0", pkg], { encoding: "utf8", timeout: 30000 });
            if (/^Success/i.test((userUninstall.stdout || "").trim())) {
              console.log(`[OK] Removed user-space install of ${pkg}`);
            } else {
              console.warn(`[WARN] Could not uninstall ${pkg}: ${(uninstallResult.stdout || "").trim()} — install may still fail due to signature mismatch`);
            }
          }
        }

        // Install
        let installed;
        if (apks.length > 1) {
          console.log(`[INFO] adb install-multiple (${apks.length} APKs)`);
          installed = await run(adb, [...serialArgs, "install-multiple", "-r", "-t", ...apks]);
        } else {
          installed = await run(adb, [...serialArgs, "install", "-r", "-t", baseApk]);
        }

        if (!installed) { console.log(`[FAILED] Install failed for ${bundleName} — skipping.`); continue; }
        console.log(`[OK] Installed ${bundleName}`);

        // Grant permissions
        console.log(`[INFO] Granting permissions for ${pkg}`);
        for (const perm of DANGEROUS_PERMISSIONS) {
          await run(adb, [...serialArgs, "shell", "pm", "grant", pkg, perm]);
        }
        console.log("[OK] Permissions granted");

        // Launch
        console.log(`[INFO] Launching ${pkg}`);
        await run(adb, [...serialArgs, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]);

        await sleep(1500);

        // Logcat
        const logFile = path.join(logDir, bundleName + ".log");
        await streamLogcat(adb, serialArgs, pkg, logFile, durationMs);

        // Uninstall
        console.log(`[INFO] Uninstalling ${pkg}`);
        await run(adb, [...serialArgs, "shell", "pm", "uninstall", pkg]);
      }

      console.log(`\n[DONE] Logs saved to ${logDir}`);
    });
}

module.exports = { register };
