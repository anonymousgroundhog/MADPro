/**
 * manifest_extractor.js
 * Extracts AndroidManifest.xml and permissions from APKs
 * Uses apktool (preferred), aapt/aapt2, or strings extraction as fallback
 */

const { spawnSync, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Dangerous permissions (Android runtime permissions)
const DANGEROUS_PERMISSIONS = new Set([
  // CALENDAR
  "android.permission.READ_CALENDAR",
  "android.permission.WRITE_CALENDAR",
  // CAMERA
  "android.permission.CAMERA",
  // CONTACTS
  "android.permission.READ_CONTACTS",
  "android.permission.WRITE_CONTACTS",
  "android.permission.GET_ACCOUNTS",
  // LOCATION
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  // MICROPHONE
  "android.permission.RECORD_AUDIO",
  // PHONE
  "android.permission.READ_PHONE_STATE",
  "android.permission.READ_PHONE_NUMBERS",
  "android.permission.CALL_PHONE",
  "android.permission.ANSWER_PHONE_CALLS",
  "android.permission.READ_CALL_LOG",
  "android.permission.WRITE_CALL_LOG",
  "android.permission.USE_SIP",
  // BODY_SENSORS
  "android.permission.BODY_SENSORS",
  "android.permission.BODY_SENSORS_BACKGROUND",
  // SMS
  "android.permission.SEND_SMS",
  "android.permission.RECEIVE_SMS",
  "android.permission.READ_SMS",
  "android.permission.RECEIVE_WAP_PUSH",
  "android.permission.RECEIVE_MMS",
  // STORAGE
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.ACCESS_MEDIA_LOCATION",
  // NEARBY_DEVICES
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.NEARBY_WIFI_DEVICES",
]);

function findTool(names) {
  for (const tool of names) {
    try {
      const result = spawnSync("which", [tool], { encoding: "utf8", timeout: 5000 });
      if (result.status === 0) return tool;
    } catch {}
  }
  return null;
}

function findAapt() {
  // First try aapt in PATH
  const found = findTool(["aapt2", "aapt"]);
  if (found) return found;

  // Check common Android SDK paths
  const sdkPaths = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env.HOME || "", "Android/Sdk"),
  ].filter(Boolean);

  for (const sdk of sdkPaths) {
    try {
      const buildToolsDir = path.join(sdk, "build-tools");
      if (!fs.existsSync(buildToolsDir)) continue;
      const versions = fs.readdirSync(buildToolsDir).sort().reverse();
      for (const version of versions) {
        for (const tool of ["aapt2", "aapt"]) {
          const toolPath = path.join(buildToolsDir, version, tool);
          if (fs.existsSync(toolPath)) return toolPath;
        }
      }
    } catch {}
  }

  return null;
}

const AAPT = findAapt();
const APKTOOL = findTool(["apktool"]);

/**
 * Extracts package info from APK using aapt dump badging
 */
function extractPackageInfo(apkPath) {
  if (!AAPT) return null;

  try {
    const result = spawnSync(AAPT, ["dump", "badging", apkPath], {
      encoding: "utf8",
      timeout: 30000,
    });

    if (result.status !== 0) return null;

    const info = {};
    const out = result.stdout || "";

    const pkgMatch = out.match(/^package: name='([^']+)'/m);
    if (pkgMatch) info.package = pkgMatch[1];

    const versionNameMatch = out.match(/versionName='([^']+)'/m);
    if (versionNameMatch) info.versionName = versionNameMatch[1];

    const versionCodeMatch = out.match(/versionCode='([^']+)'/m);
    if (versionCodeMatch) info.versionCode = versionCodeMatch[1];

    const minSdkMatch = out.match(/sdkVersion:'(\d+)'/m);
    if (minSdkMatch) info.minSdkVersion = minSdkMatch[1];

    const targetSdkMatch = out.match(/targetSdkVersion:'(\d+)'/m);
    if (targetSdkMatch) info.targetSdkVersion = targetSdkMatch[1];

    return info;
  } catch {
    return null;
  }
}

/**
 * Extracts manifest XML from APK using apktool, aapt, or strings fallback
 */
function extractManifestXml(apkPath) {
  try {
    // Method 1: apktool (best - proper decompilation)
    if (APKTOOL) {
      try {
        const tempDir = path.join(os.tmpdir(), "apktool_" + Date.now());
        const result = spawnSync(APKTOOL, ["d", "-o", tempDir, apkPath], {
          encoding: "utf8",
          timeout: 60000,
          stdio: ["ignore", "ignore", "ignore"], // Suppress apktool output
        });

        if (result.status === 0) {
          const manifestPath = path.join(tempDir, "AndroidManifest.xml");
          if (fs.existsSync(manifestPath)) {
            try {
              const xml = fs.readFileSync(manifestPath, "utf8");
              // Clean up temp directory
              try {
                execSync(`rm -rf "${tempDir}"`);
              } catch {}
              return xml;
            } catch {}
          }
          // Clean up on failure
          try {
            execSync(`rm -rf "${tempDir}"`);
          } catch {}
        }
      } catch {}
    }

    // Method 2: aapt dump xmltree
    if (AAPT) {
      try {
        const result = spawnSync(AAPT, ["dump", "xmltree", apkPath, "AndroidManifest.xml"], {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 256 * 1024 * 1024,
        });

        if (result.status === 0 && result.stdout) return result.stdout;
      } catch {}
    }

    // Method 3: Extract binary manifest and show strings
    try {
      const unzipResult = spawnSync("unzip", ["-p", apkPath, "AndroidManifest.xml"], {
        encoding: "buffer",
        timeout: 30000,
        maxBuffer: 256 * 1024 * 1024,
      });

      if (unzipResult.status === 0 && unzipResult.stdout) {
        const stringsResult = spawnSync("strings", [], {
          input: unzipResult.stdout,
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 64 * 1024 * 1024,
        });
        if (stringsResult.stdout) {
          const lines = stringsResult.stdout
            .split("\n")
            .filter(l => l.trim().length > 0 && (l.includes("android") || l.includes("permission") || l.includes("activity") || l.includes("service")))
            .slice(0, 150);
          return "<!-- Extracted from binary manifest (strings) -->\n" + lines.map(l => l.trim()).join("\n");
        }
      }
    } catch {}

    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts permissions from manifest
 */
function extractPermissions(apkPath) {
  const xml = extractManifestXml(apkPath);
  if (!xml) return { all: [], dangerous: [] };

  const permPattern = /android:name="(android\.permission\.[^"]+)"/g;
  const permissions = new Set();
  let match;

  while ((match = permPattern.exec(xml)) !== null) {
    permissions.add(match[1]);
  }

  const sortedPerms = [...permissions].sort();
  const dangerous = sortedPerms.filter((p) => DANGEROUS_PERMISSIONS.has(p));

  return {
    all: sortedPerms,
    dangerous,
  };
}

/**
 * Gets complete manifest summary
 */
function getManifestSummary(apkPath) {
  try {
    const packageInfo = extractPackageInfo(apkPath) || {};
    const perms = extractPermissions(apkPath);
    let manifestXml = extractManifestXml(apkPath);

    // Ensure manifestXml is a safe string or null
    if (manifestXml && typeof manifestXml === 'string') {
      // Truncate if too large to avoid memory issues
      if (manifestXml.length > 100000) {
        manifestXml = manifestXml.substring(0, 100000) + '\n\n[truncated...]';
      }
    } else {
      manifestXml = null;
    }

    return {
      packageInfo,
      permissions: perms.all,
      dangerousPermissions: perms.dangerous,
      manifestXml,
      error: null,
      toolsAvailable: {
        apktool: !!APKTOOL,
        aapt: !!AAPT,
      },
    };
  } catch (err) {
    return {
      packageInfo: {},
      permissions: [],
      dangerousPermissions: [],
      manifestXml: null,
      error: err.message,
      toolsAvailable: {
        apktool: !!APKTOOL,
        aapt: !!AAPT,
      },
    };
  }
}

module.exports = {
  getManifestSummary,
  extractManifestXml,
  extractPackageInfo,
  extractPermissions,
  DANGEROUS_PERMISSIONS,
  AAPT,
  APKTOOL,
};
