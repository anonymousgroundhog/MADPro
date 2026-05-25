/**
 * commands/setup-emulator.js
 * `madpro setup-emulator` — download a system image, create/recreate an AVD, and boot it.
 *
 * Modes:
 *   --fresh <avd-name>   Delete existing AVD (if any) and create from scratch
 *   (default)            Create new AVD; error if name already exists
 *
 * Defaults to android-36 / google_apis / x86_64.
 * Launches with: -gpu host -no-snapshot -feature -Vulkan
 * The -feature -Vulkan flag (disables Vulkan) is required on Intel/Mesa hosts to
 * prevent the grey screen bug in emulator 36.x.
 */

const { execSync, spawnSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function detectDisplay() {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  try {
    const locks = fs.readdirSync("/tmp").filter(f => /^\.X\d+-lock$/.test(f));
    if (locks.length) return `:${locks[0].match(/\.X(\d+)-lock/)[1]}`;
  } catch {}
  return ":1";
}
const os = require("os");
const { findAdb } = require("../lib/tools");

// ── SDK tool discovery ────────────────────────────────────────────────────────

function findSdkRoot() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Android", "Sdk"),
    path.join(os.homedir(), "android-sdk"),
    "/opt/android-sdk",
  ].filter(Boolean);
  for (const r of candidates) {
    if (fs.existsSync(path.join(r, "platforms"))) return r;
  }
  return null;
}

function findCmdlineTool(name) {
  const sdk = findSdkRoot();
  if (sdk) {
    // cmdline-tools may be under latest/ or a version number
    const cmdDir = path.join(sdk, "cmdline-tools");
    if (fs.existsSync(cmdDir)) {
      for (const sub of fs.readdirSync(cmdDir).sort().reverse()) {
        const p = path.join(cmdDir, sub, "bin", name);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  try { return execSync(`which ${name}`, { encoding: "utf8" }).trim(); } catch { return null; }
}

function findEmulatorBin() {
  const sdk = findSdkRoot();
  if (sdk) {
    const p = path.join(sdk, "emulator", "emulator");
    if (fs.existsSync(p)) return p;
  }
  try { return execSync("which emulator", { encoding: "utf8" }).trim(); } catch { return null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function listInstalledImages(sdkmanager) {
  try {
    const out = execSync(`"${sdkmanager}" --list_installed 2>/dev/null`, {
      encoding: "utf8", timeout: 30000,
    });
    return out.split("\n")
      .map(l => l.trim())
      .filter(l => l.startsWith("system-images;"));
  } catch { return []; }
}

function imageInstalled(sdkmanager, pkg) {
  return listInstalledImages(sdkmanager).some(l => l.startsWith(pkg));
}

function avdExists(avdmanager, name) {
  try {
    const out = execSync(`"${avdmanager}" list avd -c 2>/dev/null`, {
      encoding: "utf8", timeout: 10000,
    });
    return out.split("\n").map(l => l.trim()).includes(name);
  } catch { return false; }
}

function deleteAvd(name) {
  const avdDir = path.join(os.homedir(), ".android", "avd");
  for (const ext of [".avd", ".ini"]) {
    const target = path.join(avdDir, name + ext);
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`[INFO] Deleted ${target}`);
      }
    } catch (e) {
      console.warn(`[WARN] Could not delete ${target}: ${e.message}`);
    }
  }
}

function waitForBoot(adb, serial, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const serialArgs = serial ? ["-s", serial] : [];
  console.log("[INFO] Waiting for emulator to come online...");
  return new Promise((resolve, reject) => {
    // Phase 1: wait-for-device so ADB channel is established before polling
    try {
      execSync(`"${adb}" ${serialArgs.join(" ")} wait-for-device`, { timeout: timeoutMs });
    } catch {}

    console.log("[INFO] Device online — waiting for boot to complete...");

    function poll() {
      if (Date.now() > deadline)
        return reject(new Error(`Emulator did not boot within ${timeoutMs / 1000}s`));
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

// ── Command ───────────────────────────────────────────────────────────────────

function register(program) {
  program
    .command("setup-emulator")
    .description("Download system image, create/recreate AVD, and boot it")
    .argument("<avd-name>", "Name for the AVD (created or recreated)")
    .option("--fresh", "Delete existing AVD and recreate from scratch", false)
    .option("--api <level>", "Android API level", "36")
    .option("--tag <tag>", "System image tag: google_apis | google_apis_playstore | default", "google_apis")
    .option("--abi <abi>", "ABI: x86_64 | arm64-v8a", "x86_64")
    .option("--device <type>", "Hardware profile (avdmanager --list device)", "pixel_6")
    .option("--sdcard <mb>", "SD card size in MB", "2048")
    .option("--gpu <mode>", "GPU mode: auto | host | swiftshader_indirect | off", "host")
    .option("--headless", "Boot without a window (swiftshader_indirect)", false)
    .option("--no-boot", "Create AVD but do not boot it", false)
    .option("--timeout <ms>", "Max boot wait time in ms", "180000")
    .action(async (avdName, opts) => {
      const sdkmanager = findCmdlineTool("sdkmanager");
      const avdmanager = findCmdlineTool("avdmanager");
      const emulator   = findEmulatorBin();
      const adb        = findAdb() || "adb";

      if (!sdkmanager) { console.error("ERROR: sdkmanager not found. Install Android cmdline-tools."); process.exit(1); }
      if (!avdmanager) { console.error("ERROR: avdmanager not found. Install Android cmdline-tools."); process.exit(1); }
      if (!emulator)   { console.error("ERROR: emulator not found. Install Android emulator package."); process.exit(1); }

      const pkg = `system-images;android-${opts.api};${opts.tag};${opts.abi}`;
      console.log(`\n[INFO] System image : ${pkg}`);
      console.log(`[INFO] AVD name     : ${avdName}`);
      console.log(`[INFO] Device type  : ${opts.device}`);
      console.log(`[INFO] SD card      : ${opts.sdcard} MB\n`);

      // ── 1. Download system image if not installed ─────────────────────────
      if (imageInstalled(sdkmanager, pkg)) {
        console.log("[OK] System image already installed — skipping download.");
      } else {
        console.log(`[INFO] Downloading system image (this may take several minutes)...`);
        const dlResult = spawnSync(
          sdkmanager,
          ["--install", pkg],
          { stdio: ["ignore", "inherit", "inherit"], timeout: 20 * 60 * 1000 }
        );
        if (dlResult.status !== 0) {
          console.error(`[ERROR] sdkmanager failed (exit ${dlResult.status}).`);
          console.error("        Try accepting licenses first: sdkmanager --licenses");
          process.exit(1);
        }
        console.log("[OK] System image downloaded.");
      }

      // ── 2. Handle existing AVD ────────────────────────────────────────────
      if (avdExists(avdmanager, avdName)) {
        if (!opts.fresh) {
          console.error(`[ERROR] AVD "${avdName}" already exists. Use --fresh to delete and recreate it.`);
          process.exit(1);
        }
        console.log(`[INFO] --fresh: deleting existing AVD "${avdName}"...`);
      }
      // Always delete before create — avdmanager --force does not overwrite the
      // .ini target field, leaving a stale system image pointer if the API changed.
      deleteAvd(avdName);

      // ── 3. Create AVD ─────────────────────────────────────────────────────
      console.log(`[INFO] Creating AVD "${avdName}"...`);
      const createResult = spawnSync(
        avdmanager,
        [
          "create", "avd",
          "--name", avdName,
          "--package", pkg,
          "--device", opts.device,
          "--sdcard", `${opts.sdcard}M`,
          "--force",
        ],
        {
          // avdmanager prompts "Do you wish to create a custom hardware profile?" — answer no
          input: "no\n",
          encoding: "utf8",
          timeout: 60000,
        }
      );
      if (createResult.status !== 0) {
        console.error(`[ERROR] avdmanager create failed:\n${createResult.stderr || ""}`);
        process.exit(1);
      }
      console.log(`[OK] AVD "${avdName}" created.`);

      if (opts.noBoot) {
        console.log("[INFO] --no-boot set — skipping launch.");
        console.log(`\nTo start later: madpro start-emulator ${avdName}`);
        return;
      }

      // ── 4. Boot ───────────────────────────────────────────────────────────
      const emulatorArgs = ["-avd", avdName, "-gpu", "host", "-no-snapshot", "-feature", "-Vulkan"];
      if (opts.headless) emulatorArgs.push("-no-window");

      console.log(`\n[INFO] Booting emulator: ${emulator} ${emulatorArgs.join(" ")}`);

      const proc = spawn(emulator, emulatorArgs, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, DISPLAY: detectDisplay() },
      });
      proc.unref();
      console.log(`[INFO] Emulator process launched (pid ${proc.pid})`);

      // Give ADB a moment to register the new device
      await new Promise(r => setTimeout(r, 6000));

      function detectSerial() {
        try {
          const out = execSync(`"${adb}" devices`, { encoding: "utf8", timeout: 8000 });
          const lines = out.split("\n")
            .filter(l => l.includes("emulator") && l.split(/\s+/)[1] === "device");
          return lines.length ? lines[lines.length - 1].split(/\s+/)[0] : null;
        } catch { return null; }
      }

      let serial = detectSerial();
      if (!serial) {
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 3000));
          serial = detectSerial();
          if (serial) break;
        }
      }

      if (serial) console.log(`[INFO] Detected emulator serial: ${serial}`);

      const timeoutMs = parseInt(opts.timeout, 10) || 180000;
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
        console.log(`\n[OK] Emulator ready — serial: ${serial || "(auto)"}`);
        if (serial) {
          console.log(`\nNext steps:`);
          console.log(`  madpro instrument <apk-dir> -d ${serial}`);
          console.log(`  madpro download -b google-play -c SOCIAL -n 5 -d ${serial} -o ./apks`);
        }
      } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
