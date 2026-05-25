/**
 * commands/start-emulator.js
 * `madpro start-emulator` — launch an AVD and wait until it is fully booted.
 */

const { execSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { findAdb } = require("../lib/tools");

function detectDisplay() {
  // Use existing DISPLAY if set
  if (process.env.DISPLAY) return process.env.DISPLAY;
  // Try to find an active X display from /tmp/.X*-lock files
  try {
    const locks = fs.readdirSync("/tmp").filter(f => /^\.X\d+-lock$/.test(f));
    if (locks.length) {
      const num = locks[0].match(/\.X(\d+)-lock/)[1];
      return `:${num}`;
    }
  } catch {}
  return ":1";
}

function findEmulatorBin() {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Android", "Sdk"),
    path.join(os.homedir(), "android-sdk"),
    "/opt/android-sdk",
  ].filter(Boolean);
  for (const root of sdkRoots) {
    const p = path.join(root, "emulator", "emulator");
    if (fs.existsSync(p)) return p;
  }
  try { return execSync("which emulator", { encoding: "utf8" }).trim(); } catch { return null; }
}

function listAvds() {
  try {
    const out = execSync(
      "emulator -list-avds 2>/dev/null || avdmanager list avd -c 2>/dev/null",
      { encoding: "utf8", shell: true, timeout: 10000 }
    );
    return out.split("\n").map(l => l.trim()).filter(Boolean);
  } catch { return []; }
}

function waitForBoot(adb, serial, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  const serialArgs = serial ? ["-s", serial] : [];
  console.log("[INFO] Waiting for emulator to come online...");

  return new Promise((resolve, reject) => {
    // Phase 1: wait-for-device (blocks until ADB sees the device)
    try {
      execSync(`"${adb}" ${serialArgs.join(" ")} wait-for-device`, { timeout: timeoutMs });
    } catch {}

    console.log("[INFO] Device online — waiting for boot to complete...");

    function poll() {
      if (Date.now() > deadline) {
        return reject(new Error(`Emulator did not boot within ${timeoutMs / 1000}s`));
      }
      try {
        const r = execSync(
          `"${adb}" ${serialArgs.join(" ")} shell getprop sys.boot_completed 2>/dev/null`,
          { encoding: "utf8", timeout: 5000 }
        ).trim();
        if (r === "1") return resolve();
      } catch {}
      setTimeout(poll, 3000);
    }
    poll();
  });
}

function register(program) {
  program
    .command("start-emulator")
    .description("Launch an Android AVD emulator and wait until fully booted")
    .argument("[avd-name]", "AVD name to launch (omit to list available AVDs)")
    .option("--no-snapshot", "Cold boot — ignore saved snapshot", false)
    .option("--wipe-data", "Wipe userdata partition before boot", false)
    .option("--no-audio", "Disable audio", true)
    .option("--gpu <mode>", "GPU mode: auto | host | swiftshader_indirect | off", "host")
    .option("--timeout <ms>", "Max boot wait time in ms", "300000")
    .option("--headless", "Run without a window (use swiftshader_indirect GPU)", false)
    .action(async (avdName, opts) => {
      const emulator = findEmulatorBin();
      if (!emulator) {
        console.error("ERROR: emulator binary not found. Install Android SDK emulator package.");
        process.exit(1);
      }

      const avds = listAvds();

      if (!avdName) {
        console.log("\nAvailable AVDs:");
        if (!avds.length) {
          console.log("  (none) — create one with: avdmanager create avd -n <name> -k <package>");
        } else {
          for (const a of avds) console.log(`  ${a}`);
          console.log(`\nUsage: madpro start-emulator <avd-name>`);
        }
        return;
      }

      if (!avds.includes(avdName)) {
        console.error(`ERROR: AVD "${avdName}" not found.`);
        console.log("Available AVDs:", avds.length ? avds.join(", ") : "(none)");
        process.exit(1);
      }

      const emulatorArgs = ["-avd", avdName, "-gpu", "host", "-no-snapshot", "-feature", "-Vulkan"];

      if (opts.wipeData) emulatorArgs.push("-wipe-data");
      if (opts.noAudio)  emulatorArgs.push("-no-audio");
      if (opts.headless) emulatorArgs.push("-no-window");

      console.log(`[INFO] Starting AVD: ${avdName}`);
      console.log(`[INFO] Cmd: ${emulator} ${emulatorArgs.join(" ")}`);

      const proc = spawn(emulator, emulatorArgs, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, DISPLAY: detectDisplay() },
      });
      proc.unref();

      console.log(`[INFO] Emulator process launched (pid ${proc.pid})`);

      // Give ADB a moment to register the new device
      await new Promise(r => setTimeout(r, 6000));

      const adb = findAdb() || "adb";

      // Find the serial — only pick 'device' (online) entries, not 'offline'
      function detectSerial() {
        try {
          const out = execSync(`"${adb}" devices`, { encoding: "utf8", timeout: 8000 });
          const lines = out.split("\n")
            .filter(l => l.includes("emulator") && l.split(/\s+/)[1] === "device");
          return lines.length ? lines[lines.length - 1].split(/\s+/)[0] : null;
        } catch { return null; }
      }

      let serial = detectSerial();
      // Device may still be offline — retry a few times
      if (!serial) {
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 3000));
          serial = detectSerial();
          if (serial) break;
        }
      }

      if (serial) console.log(`[INFO] Detected emulator serial: ${serial}`);

      const timeoutMs = parseInt(opts.timeout, 10) || 120000;
      try {
        await waitForBoot(adb, serial, timeoutMs);
        // Wake screen and dismiss keyguard — SurfaceFlinger may leave window grey until input arrives
        const serialArgs = serial ? ["-s", serial] : [];
        console.log("[INFO] Waking screen...");
        await new Promise(r => setTimeout(r, 3000));
        try { execSync(`"${adb}" ${serialArgs.join(" ")} shell input keyevent KEYCODE_WAKEUP`, { timeout: 5000 }); } catch {}
        await new Promise(r => setTimeout(r, 1000));
        try { execSync(`"${adb}" ${serialArgs.join(" ")} shell input keyevent KEYCODE_MENU`, { timeout: 5000 }); } catch {}
        await new Promise(r => setTimeout(r, 3000));
        console.log(`[OK] Emulator ready — serial: ${serial || "(auto)"}`);
        if (serial) console.log(`     Use: madpro instrument <dir> -d ${serial}`);
      } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
