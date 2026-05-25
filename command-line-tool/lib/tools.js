/**
 * lib/tools.js
 * Binary/tool detection helpers shared across CLI commands.
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

function which(name) {
  try { return execSync(`which ${name}`, { encoding: "utf8" }).trim(); } catch { return null; }
}

function findBin(name) {
  const fromPath = which(name);
  if (fromPath) return fromPath;
  const extra = [
    path.join(os.homedir(), ".cargo", "bin", name),
    path.join(os.homedir(), ".local", "bin", name),
    "/usr/local/bin/" + name,
    "/usr/bin/" + name,
    "/opt/homebrew/bin/" + name,
  ];
  for (const p of extra) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findAdb() {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Android", "Sdk"),
    path.join(os.homedir(), "android-sdk"),
    "/opt/android-sdk",
  ].filter(Boolean);
  for (const root of sdkRoots) {
    const p = path.join(root, "platform-tools", "adb");
    if (fs.existsSync(p)) return p;
  }
  return which("adb");
}

function findBuildTool(name) {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Android", "Sdk"),
    path.join(os.homedir(), "android-sdk"),
  ].filter(Boolean);
  for (const root of sdkRoots) {
    const btDir = path.join(root, "build-tools");
    if (!fs.existsSync(btDir)) continue;
    const versions = fs.readdirSync(btDir).sort().reverse();
    for (const v of versions) {
      const p = path.join(btDir, v, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return which(name);
}

function findAndroidPlatforms() {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Android", "Sdk"),
    path.join(os.homedir(), "android-sdk"),
    "/opt/android-sdk",
  ].filter(Boolean);
  for (const root of sdkRoots) {
    const p = path.join(root, "platforms");
    if (fs.existsSync(p) && fs.readdirSync(p).length > 0) return p;
  }
  return null;
}

const PROJECT_ROOT   = path.resolve(__dirname, "../..");
const JAR_LIBS_DIR   = path.join(PROJECT_ROOT, "jar_libs");
const JAVA_SRC_DIR   = path.join(PROJECT_ROOT, "java");
const INJECTOR_CLASS = path.join(JAVA_SRC_DIR, "LogInjector.class");

function checkTools() {
  const platforms = findAndroidPlatforms();
  return {
    apkeep:    !!findBin("apkeep"),
    java:      !!findBin("java"),
    adb:       !!findAdb(),
    apktool:   !!findBin("apktool"),
    curl:      !!findBin("curl"),
    zipalign:  !!findBuildTool("zipalign"),
    apksigner: !!findBuildTool("apksigner"),
    platforms: !!platforms,
    platformsPath: platforms,
    injectorCompiled: fs.existsSync(INJECTOR_CLASS),
    jarLibsExist: fs.existsSync(JAR_LIBS_DIR) && fs.readdirSync(JAR_LIBS_DIR).some(f => f.endsWith(".jar")),
  };
}

module.exports = {
  which,
  findBin,
  findAdb,
  findBuildTool,
  findAndroidPlatforms,
  checkTools,
  PROJECT_ROOT,
  JAR_LIBS_DIR,
  JAVA_SRC_DIR,
  INJECTOR_CLASS,
};
