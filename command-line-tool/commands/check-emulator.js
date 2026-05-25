/**
 * commands/check-emulator.js
 * `madpro check-emulator` — diagnose emulator GPU, renderer, KVM, and AVD readiness.
 *
 * Checks performed:
 *   1. KVM availability and usability
 *   2. emulator binary presence
 *   3. sdkmanager / avdmanager presence
 *   4. Vulkan driver on host (required for gfxstream)
 *   5. GuestAngle requirement for API > 35
 *   6. Installed system images
 *   7. Existing AVDs — API level, tag, and whether GuestAngle is needed
 *   8. Recommended launch flags for each AVD
 */

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

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

function findBin(name) {
  try { return execSync(`which ${name}`, { encoding: "utf8" }).trim(); } catch { return null; }
}

function findSdkBin(name) {
  const sdk = findSdkRoot();
  if (sdk) {
    const cmdDir = path.join(sdk, "cmdline-tools");
    if (fs.existsSync(cmdDir)) {
      for (const sub of fs.readdirSync(cmdDir).sort().reverse()) {
        const p = path.join(cmdDir, sub, "bin", name);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return findBin(name);
}

function findEmulatorBin() {
  const sdk = findSdkRoot();
  if (sdk) {
    const p = path.join(sdk, "emulator", "emulator");
    if (fs.existsSync(p)) return p;
  }
  return findBin("emulator");
}

function checkKvm() {
  // Check device node exists
  if (!fs.existsSync("/dev/kvm")) return { ok: false, detail: "/dev/kvm not found — install kvm: sudo apt install qemu-kvm" };
  // Check permission
  try {
    fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    return { ok: false, detail: "/dev/kvm exists but not accessible — run: sudo usermod -aG kvm $USER && newgrp kvm" };
  }
  // Run emulator accel-check if available
  const emulator = findEmulatorBin();
  if (emulator) {
    try {
      const r = spawnSync(emulator, ["-accel-check"], { encoding: "utf8", timeout: 10000 });
      const out = (r.stdout || "") + (r.stderr || "");
      if (out.includes("KVM") && out.includes("usable")) return { ok: true, detail: "KVM usable" };
      if (out.includes("accel") && r.status === 0) return { ok: true, detail: "acceleration available" };
    } catch {}
  }
  return { ok: true, detail: "/dev/kvm accessible" };
}

function checkVulkan() {
  const sdk = findSdkRoot();
  if (!sdk) return { ok: false, detail: "SDK not found" };
  const libPath = path.join(sdk, "emulator", "lib64", "vulkan", "libvulkan.so");
  if (!fs.existsSync(libPath)) return { ok: false, detail: "emulator Vulkan lib missing" };

  // Try vulkaninfo or check system vulkan
  try {
    const r = spawnSync("vulkaninfo", ["--summary"], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0 && r.stdout.includes("apiVersion")) {
      const match = r.stdout.match(/apiVersion\s*=\s*(\S+)/);
      return { ok: true, detail: `host Vulkan ${match ? match[1] : "available"}` };
    }
  } catch {}

  // Fallback: check for system vulkan ICD
  const icdPaths = ["/usr/share/vulkan/icd.d", "/etc/vulkan/icd.d"];
  for (const p of icdPaths) {
    if (fs.existsSync(p) && fs.readdirSync(p).length > 0) {
      return { ok: true, detail: `ICD found at ${p}` };
    }
  }
  return { ok: false, detail: "no Vulkan ICD found — install mesa-vulkan-drivers" };
}

function getInstalledImages() {
  const sdk = findSdkRoot();
  if (!sdk) return [];
  const base = path.join(sdk, "system-images");
  if (!fs.existsSync(base)) return [];
  const images = [];
  for (const api of fs.readdirSync(base).sort()) {
    const apiPath = path.join(base, api);
    if (!fs.statSync(apiPath).isDirectory()) continue;
    for (const tag of fs.readdirSync(apiPath).sort()) {
      const tagPath = path.join(apiPath, tag);
      if (!fs.statSync(tagPath).isDirectory()) continue;
      for (const abi of fs.readdirSync(tagPath).sort()) {
        const abiPath = path.join(tagPath, abi);
        if (fs.statSync(abiPath).isDirectory()) {
          images.push({ api, tag, abi, pkg: `system-images;${api};${tag};${abi}` });
        }
      }
    }
  }
  return images;
}

function getAvds(avdmanager) {
  if (!avdmanager) return [];
  try {
    const r = spawnSync(avdmanager, ["list", "avd"], { encoding: "utf8", timeout: 15000 });
    const out = r.stdout || "";
    const avds = [];
    let current = null;
    for (const line of out.split("\n")) {
      const namM = line.match(/^\s+Name:\s+(.+)$/);
      const pathM = line.match(/^\s+Path:\s+(.+)$/);
      const targM = line.match(/^\s+Target:\s+(.+)$/);
      const basedM = line.match(/Based on:\s+Android\s+[\d.]+\s+\("?[^"]+?"?\)\s+Tag\/ABI:\s+(\S+)\/(\S+)/);
      if (namM)  { current = { name: namM[1].trim(), path: null, target: null, tag: null, abi: null, api: null }; avds.push(current); }
      if (current && pathM)  current.path = pathM[1].trim();
      if (current && targM)  current.target = targM[1].trim();
      if (current && basedM) { current.tag = basedM[1]; current.abi = basedM[2]; }
    }
    // Parse API level from config.ini for accuracy
    for (const avd of avds) {
      if (avd.path) {
        const cfg = path.join(avd.path, "config.ini");
        try {
          const ini = fs.readFileSync(cfg, "utf8");
          const imgM = ini.match(/^image\.sysdir\.1\s*=\s*system-images\/(android-(\d+))/m);
          if (imgM) avd.api = parseInt(imgM[2], 10);
          if (!avd.tag) {
            const tagM = ini.match(/^tag\.id\s*=\s*(.+)$/m);
            if (tagM) avd.tag = tagM[1].trim();
          }
          if (!avd.abi) {
            const abiM = ini.match(/^abi\.type\s*=\s*(.+)$/m);
            if (abiM) avd.abi = abiM[1].trim();
          }
        } catch {}
      }
    }
    return avds;
  } catch { return []; }
}

function register(program) {
  program
    .command("check-emulator")
    .description("Diagnose emulator GPU, renderer, KVM, and AVD readiness")
    .action(() => {
      const ok  = s => `  [\x1b[32m✓\x1b[0m] ${s}`;
      const bad = s => `  [\x1b[31m✗\x1b[0m] ${s}`;
      const inf = s => `  [\x1b[33m!\x1b[0m] ${s}`;
      const hdr = s => `\n${s}\n${"─".repeat(s.length)}`;

      console.log(hdr("Emulator Environment Check"));

      // ── KVM ──────────────────────────────────────────────────────────────
      console.log(hdr("KVM / Hardware Acceleration"));
      const kvm = checkKvm();
      console.log(kvm.ok ? ok(kvm.detail) : bad(kvm.detail));

      // ── Binaries ─────────────────────────────────────────────────────────
      console.log(hdr("Required Binaries"));
      const emulator   = findEmulatorBin();
      const sdkmanager = findSdkBin("sdkmanager");
      const avdmanager = findSdkBin("avdmanager");
      console.log(emulator   ? ok(`emulator     ${emulator}`)   : bad("emulator     not found — install Android SDK emulator package"));
      console.log(sdkmanager ? ok(`sdkmanager   ${sdkmanager}`) : bad("sdkmanager   not found — install Android cmdline-tools"));
      console.log(avdmanager ? ok(`avdmanager   ${avdmanager}`) : bad("avdmanager   not found — install Android cmdline-tools"));

      // ── Vulkan ───────────────────────────────────────────────────────────
      console.log(hdr("Host Vulkan (required for gfxstream renderer)"));
      const vulkan = checkVulkan();
      console.log(vulkan.ok ? ok(vulkan.detail) : bad(vulkan.detail));

      // ── GuestAngle note ──────────────────────────────────────────────────
      console.log(hdr("GuestAngle Renderer (API > 35)"));
      console.log(inf("Emulator 36.x disables GuestAngle for API > 35 by default."));
      console.log(inf("Grey screen on API 36+ is caused by this. Fix: always pass -feature GuestAngle."));
      console.log(ok("madpro start-emulator and setup-emulator include -feature GuestAngle automatically."));

      // ── Installed system images ───────────────────────────────────────────
      console.log(hdr("Installed System Images"));
      const images = getInstalledImages();
      if (!images.length) {
        console.log(bad("No system images found. Install one:"));
        console.log("       sdkmanager \"system-images;android-35;google_apis_playstore;x86_64\"");
      } else {
        for (const img of images) {
          const api = parseInt(img.api.replace("android-", ""), 10);
          const needsAngle = api > 35 ? " \x1b[33m← needs -feature GuestAngle\x1b[0m" : "";
          console.log(ok(`${img.pkg}${needsAngle}`));
        }
      }

      // ── AVDs ─────────────────────────────────────────────────────────────
      console.log(hdr("Existing AVDs"));
      const avds = getAvds(avdmanager);
      if (!avds.length) {
        console.log(inf("No AVDs found. Create one: madpro setup-emulator <name>"));
      } else {
        for (const avd of avds) {
          const apiNum  = avd.api || 0;
          const needsAngle = apiNum > 35;
          const angleNote  = needsAngle ? " \x1b[33m[needs -feature GuestAngle]\x1b[0m" : "";
          const imageNote  = avd.tag ? ` (${avd.tag}/${avd.abi || "?"})` : "";
          console.log(ok(`${avd.name}  API ${avd.api || "?"}${imageNote}${angleNote}`));

          // Recommended launch command
          const gpuFlag = needsAngle ? "-gpu host -feature GuestAngle" : "-gpu host";
          console.log(`         → madpro start-emulator ${avd.name}  [flags: ${gpuFlag}]`);
        }
      }

      console.log();
    });
}

module.exports = { register };
