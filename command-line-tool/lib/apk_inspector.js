/**
 * apk_inspector.js
 *
 * Static analysis of APK files for ad SDK traces and Play Store references.
 * Used as a fallback when an app is not found on the Play Store.
 *
 * Three detection layers (fast → thorough):
 *  1. ZIP file listing  — META-INF adapter manifests, assets (no extraction needed)
 *  2. DEX string scan   — Lcom/... class path prefixes in classes*.dex
 *  3. AndroidManifest   — permissions and intent filters (billing, vending)
 */

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// ── Known ad SDK signatures ──────────────────────────────────────────────────

// Maps a matched token → human-readable SDK name
const DEX_AD_PATTERNS = [
  // Google
  { pattern: /Lcom\/google\/android\/gms\/ads/,            name: "Google AdMob" },
  { pattern: /Lcom\/google\/ads/,                          name: "Google Ads" },
  // Meta / Facebook
  { pattern: /Lcom\/facebook\/ads/,                        name: "Facebook Audience Network" },
  // AppLovin
  { pattern: /Lcom\/applovin/,                             name: "AppLovin" },
  // Unity
  { pattern: /Lcom\/unity3d\/ads/,                         name: "Unity Ads" },
  // IronSource
  { pattern: /Lcom\/ironsource/,                           name: "IronSource" },
  // Vungle / Liftoff
  { pattern: /Lcom\/vungle/,                               name: "Vungle" },
  // MoPub (Twitter)
  { pattern: /Lcom\/mopub/,                                name: "MoPub" },
  // InMobi
  { pattern: /Lcom\/inmobi/,                               name: "InMobi" },
  // Chartboost
  { pattern: /Lcom\/chartboost/,                           name: "Chartboost" },
  // StartApp
  { pattern: /Lcom\/startapp/,                             name: "StartApp" },
  // Tapjoy
  { pattern: /Lcom\/tapjoy/,                               name: "Tapjoy" },
  // Mintegral
  { pattern: /Lcom\/mintegral/,                            name: "Mintegral" },
  // Fyber
  { pattern: /Lcom\/fyber/,                                name: "Fyber" },
  // Digital Turbine
  { pattern: /Lcom\/digitalturbine/,                       name: "Digital Turbine" },
  // AdColony
  { pattern: /Lcom\/adcolony/,                             name: "AdColony" },
];

// META-INF path fragments → SDK name
const METAINF_AD_PATTERNS = [
  { pattern: /applovin\/mediation/i,                       name: "AppLovin Mediation" },
  { pattern: /facebook-adapter/i,                          name: "Facebook Audience Network" },
  { pattern: /google-adapter|google-ad-manager/i,          name: "Google AdMob" },
  { pattern: /ironsource/i,                                name: "IronSource" },
  { pattern: /vungle/i,                                    name: "Vungle" },
  { pattern: /unityads/i,                                  name: "Unity Ads" },
  { pattern: /inmobi/i,                                    name: "InMobi" },
  { pattern: /mintegral/i,                                 name: "Mintegral" },
  { pattern: /chartboost/i,                                name: "Chartboost" },
  { pattern: /audience_network/i,                          name: "Facebook Audience Network" },
  { pattern: /privacysandbox\.ads/i,                       name: "Google Privacy Sandbox Ads" },
];

// Asset file names → SDK name
const ASSET_AD_PATTERNS = [
  { pattern: /audience_network\.dex/i,                     name: "Facebook Audience Network" },
  { pattern: /applovin/i,                                  name: "AppLovin" },
  { pattern: /unity-ads/i,                                 name: "Unity Ads" },
];

// Play Store / billing references in dex
const DEX_PLAY_PATTERNS = [
  { pattern: /Lcom\/android\/vending/,                     name: "Google Play Billing" },
  { pattern: /com\.android\.vending\.INSTALL_REFERRER/,    name: "Play Install Referrer" },
  { pattern: /Lcom\/google\/android\/play/,                name: "Google Play API" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Runs `unzip -l <apk>` and returns the list of paths inside the ZIP.
 */
function listZipEntries(apkPath) {
  const result = spawnSync("unzip", ["-l", apkPath], {
    encoding: "utf8",
    timeout: 15000,
  });
  if (!result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((l) => l.trim().replace(/^[\d\s\-:]+/, "").trim())
    .filter(Boolean);
}

/**
 * Extracts a single file from the APK and returns its binary Buffer.
 */
function extractEntry(apkPath, entryName) {
  const result = spawnSync("unzip", ["-p", apkPath, entryName], {
    encoding: "buffer",
    timeout: 30000,
    maxBuffer: 256 * 1024 * 1024, // 256 MB
  });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Runs `strings` on a Buffer and returns the output as a string.
 */
function stringsOf(buf) {
  if (!buf || buf.length === 0) return "";
  const result = spawnSync("strings", [], {
    input: buf,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout || "";
}

// ── Main inspector ───────────────────────────────────────────────────────────

/**
 * Inspects an APK for ad SDK traces and Play Store references.
 *
 * Returns:
 * {
 *   hasAds: boolean,
 *   adSdks: string[],          // list of detected SDK names
 *   hasPlayStoreTraces: boolean,
 *   playStoreTraces: string[],  // e.g. ["Google Play Billing"]
 *   method: "apk-scan",
 * }
 */
function inspectApk(apkPath) {
  const adSdks = new Set();
  const playTraces = new Set();

  // ── Layer 1: ZIP file listing (fastest, no extraction) ──────────────────
  const entries = listZipEntries(apkPath);

  for (const entry of entries) {
    for (const { pattern, name } of METAINF_AD_PATTERNS) {
      if (entry.startsWith("META-INF/") && pattern.test(entry)) {
        adSdks.add(name);
      }
    }
    for (const { pattern, name } of ASSET_AD_PATTERNS) {
      if (entry.startsWith("assets/") && pattern.test(entry)) {
        adSdks.add(name);
      }
    }
  }

  // ── Layer 2: DEX string scan ─────────────────────────────────────────────
  const dexFiles = entries.filter((e) => /^classes\d*\.dex$/.test(e));

  for (const dexFile of dexFiles) {
    const buf = extractEntry(apkPath, dexFile);
    if (!buf) continue;
    const text = stringsOf(buf);

    for (const { pattern, name } of DEX_AD_PATTERNS) {
      if (pattern.test(text)) adSdks.add(name);
    }
    for (const { pattern, name } of DEX_PLAY_PATTERNS) {
      if (pattern.test(text)) playTraces.add(name);
    }
  }

  // ── Layer 3: AndroidManifest permissions ────────────────────────────────
  const manifestBuf = extractEntry(apkPath, "AndroidManifest.xml");
  if (manifestBuf) {
    const manifestStr = stringsOf(manifestBuf);
    if (/com\.android\.vending|BILLING|InAppBillingService/i.test(manifestStr)) {
      playTraces.add("Google Play Billing (Manifest)");
    }
    if (/com\.google\.android\.c2dm|FCM|GCM/i.test(manifestStr)) {
      playTraces.add("Google Play Services (FCM/GCM)");
    }
  }

  return {
    hasAds: adSdks.size > 0,
    adSdks: [...adSdks].sort(),
    hasPlayStoreTraces: playTraces.size > 0,
    playStoreTraces: [...playTraces].sort(),
    method: "apk-scan",
  };
}

module.exports = { inspectApk };
