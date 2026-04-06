/**
 * tools-api.js
 * Server-side handlers for the Tools tab.
 * Runs everything directly on the host — no Docker required.
 *
 *  - APK download      : apkeep CLI
 *  - Log injection     : java -cp jar_libs/* LogInjector  (compiled on first use)
 *  - APK signing       : zipalign + apksigner (Android SDK build-tools)
 *  - Instrumentation   : adb install + adb shell monkey + logcat
 */

const { execSync, spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PROJECT_ROOT  = path.resolve(__dirname, "..");
const JAR_LIBS_DIR  = path.join(PROJECT_ROOT, "jar_libs");
const JAVA_SRC_DIR  = path.join(PROJECT_ROOT, "java");
const INJECTOR_SRC  = path.join(JAVA_SRC_DIR, "LogInjector.java");
const INJECTOR_CLASS = path.join(JAVA_SRC_DIR, "LogInjector.class");

// Android platforms: prefer env vars, then common SDK paths
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

// Find the newest build-tools dir for zipalign / apksigner
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
    const versions = fs.readdirSync(btDir).sort().reverse(); // newest first
    for (const v of versions) {
      const p = path.join(btDir, v, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return which(name); // fallback to PATH
}

function which(name) {
  try { return execSync(`which ${name}`, { encoding: "utf8" }).trim(); } catch { return null; }
}

// Find a user-installed binary by checking PATH + common install locations
function findBin(name) {
  const fromPath = which(name);
  if (fromPath) return fromPath;

  // Common locations when PATH is restricted (e.g. running under sudo or a limited shell)
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

// Find adb — check SDK platform-tools first, then PATH
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

// ── Tool availability ─────────────────────────────────────────────────────────

function checkTools() {
  const platforms = findAndroidPlatforms();
  return {
    apkeep:    !!findBin("apkeep"),
    java:      !!findBin("java"),
    adb:       !!findAdb(),
    apktool:   !!findBin("apktool"),
    zipalign:  !!findBuildTool("zipalign"),
    apksigner: !!findBuildTool("apksigner"),
    platforms: !!platforms,
    platformsPath: platforms,
    injectorCompiled: fs.existsSync(INJECTOR_CLASS),
    jarLibsExist: fs.existsSync(JAR_LIBS_DIR) && fs.readdirSync(JAR_LIBS_DIR).some(f => f.endsWith(".jar")),
  };
}

function listAdbDevices() {
  try {
    const adb = findAdb() || "adb";
    const out = execSync(`"${adb}" devices -l`, { encoding: "utf8", timeout: 8000 });
    return out.split("\n").slice(1)
      .filter(l => l.trim() && !l.startsWith("*"))
      .map(l => {
        const parts = l.trim().split(/\s+/);
        const serial = parts[0];
        const state  = parts[1];
        const model  = (l.match(/model:(\S+)/) || [])[1] || serial;
        const type   = serial.startsWith("emulator") ? "emulator" : "device";
        return { serial, state, model, type };
      })
      .filter(d => d.state === "device");
  } catch { return []; }
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

// ── Job registry ─────────────────────────────────────────────────────────────

let jobCounter = 0;
const jobs = new Map();

function createJob() {
  const id = String(++jobCounter);
  const job = { id, lines: [], done: false, error: null, clients: [], cancelled: false };
  jobs.set(id, job);
  return job;
}

function pushLine(job, line) {
  if (!line) return;
  job.lines.push(line);
  for (const res of job.clients) {
    try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch {}
  }
}

function finishJob(job, error = null) {
  job.done = true;
  job.error = error;
  for (const res of job.clients) {
    try {
      res.write(`data: ${JSON.stringify({ __done: true, error })}\n\n`);
      res.end();
    } catch {}
  }
  job.clients = [];
  setTimeout(() => jobs.delete(job.id), 5 * 60 * 1000);
}

// Run a subprocess and stream stdout/stderr to job log
function runProcess(job, cmd, args, opts = {}) {
  return new Promise(resolve => {
    if (job.cancelled) return resolve(false);
    const proc = spawn(cmd, args, { cwd: opts.cwd || PROJECT_ROOT, ...opts });
    job._proc = proc;
    const onLine = l => { if (l.trim()) pushLine(job, l.trim()); };
    proc.stdout?.on("data", d => d.toString().split("\n").forEach(onLine));
    proc.stderr?.on("data", d => d.toString().split("\n").forEach(onLine));
    proc.on("close", code => {
      job._proc = null;
      resolve(code === 0);
    });
    proc.on("error", err => {
      pushLine(job, `ERROR: ${err.message}`);
      job._proc = null;
      resolve(false);
    });
  });
}

// ── LogInjector compilation ──────────────────────────────────────────────────

async function ensureInjectorCompiled(job) {
  if (fs.existsSync(INJECTOR_CLASS)) {
    pushLine(job, "[INFO] LogInjector already compiled.");
    return true;
  }

  if (!fs.existsSync(INJECTOR_SRC)) {
    pushLine(job, `ERROR: LogInjector.java not found at ${INJECTOR_SRC}`);
    return false;
  }

  const jars = fs.readdirSync(JAR_LIBS_DIR)
    .filter(f => f.endsWith(".jar"))
    .map(f => path.join(JAR_LIBS_DIR, f))
    .join(":");

  const javacBin = findBin("javac") || "javac";
  pushLine(job, "--- Compiling LogInjector.java ---");
  const ok = await runProcess(job, javacBin, [
    "-cp", jars,
    "-d", JAVA_SRC_DIR,
    INJECTOR_SRC,
  ]);

  if (ok) pushLine(job, "[OK] LogInjector compiled.");
  else     pushLine(job, "[ERROR] Compilation failed — check Java is installed.");
  return ok;
}

// ── Download APKs ─────────────────────────────────────────────────────────────

const SEEDS = {
  GAME_ACTION:   ["com.kiloo.subwaysurf","com.supercell.clashofclans","com.activision.callofduty.shooter","com.gameloft.android.ANMP.GloftA9HM","com.mobile.legends","com.tencent.ig","com.dts.freefireth","com.mojang.minecraftpe","com.ea.game.nfs14_row","com.miniclip.agar.io"],
  GAME_CASUAL:   ["com.king.candycrushsaga","com.outfit7.mytalkingtom2","com.imangi.templerun2","com.halfbrick.fruitninjafree","com.rovio.angrybirds2","com.playgendary.bubblewitch3","com.bigduckgames.flow","com.dena.a12026418","jp.gungho.pad"],
  GAME_PUZZLE:   ["com.king.candycrushsodaga","com.gram.chess","com.ea.game.sudoku","com.halfbrick.jetpackjoyride","com.innersloth.spacemafia","com.scopely.monopoly","com.nianticlabs.pokemongo"],
  GAME_ROLE_PLAYING: ["com.supercell.clashroyale","com.ngame.slimesaga","com.garena.lifeafter","jp.gungho.pad"],
  SOCIAL:        ["com.instagram.android","com.facebook.katana","com.twitter.android","com.snapchat.android","com.pinterest","com.reddit.frontpage","com.linkedin.android","com.discord"],
  COMMUNICATION: ["com.whatsapp","org.telegram.messenger","com.viber.voip","com.skype.raider","com.google.android.talk","com.microsoft.teams","com.slack","com.zoom.videomeetings","com.signal.android","com.facebook.orca"],
  PRODUCTIVITY:  ["com.microsoft.office.word","com.microsoft.office.excel","com.google.android.apps.docs","com.google.android.apps.sheets","com.dropbox.android","com.evernote","com.todoist.android","com.anydo","com.notion.id","com.trello"],
  ENTERTAINMENT: ["com.netflix.mediaclient","com.amazon.avod.thirdpartyclient","com.disney.disneyplus","com.hbo.hbonow","com.hulu.plus","com.google.android.youtube","com.spotify.music","com.tiktok"],
  FINANCE:       ["com.paypal.android.p2pmobile","com.venmo","com.cashapp","com.robinhood.android","com.coinbase.android"],
  HEALTH_AND_FITNESS: ["com.myfitnesspal.android","com.nike.plusrunning","com.strava","com.fitbit.FitbitMobile","com.headspace.android","com.calm.android"],
  EDUCATION:     ["com.duolingo","com.kahoot.academy","com.coursera.android","com.udemy.android","com.khanacademy.android"],
  MUSIC_AND_AUDIO: ["com.spotify.music","com.pandora.android","deezer.android.app","com.soundcloud.android","com.shazam.android"],
  NEWS_AND_MAGAZINES: ["com.google.android.apps.magazines","flipboard.app","com.nytimes.android","com.bbc.mobile.news.ww"],
  SHOPPING:      ["com.amazon.mShop.android.shopping","com.ebay.mobile","com.etsy.android","com.wish.android"],
  TRAVEL_AND_LOCAL: ["com.airbnb.android","com.booking.android","com.expedia.bookings","com.google.android.apps.maps","com.waze","com.ubercab"],
  TOOLS:         ["com.google.android.apps.translate","com.adobe.scan.android","com.lastpass.lpandroid","com.nordvpn.android"],
  PHOTOGRAPHY:   ["com.instagram.android","com.vsco.cam","com.picsart.studio","com.adobe.lrmobile"],
  BUSINESS:      ["com.microsoft.teams","com.slack","com.zoom.videomeetings","com.hubspot.android"],
  MEDICAL:       ["com.webmd.android","com.zocdoc.android","com.teladoc.app"],
  MAPS_AND_NAVIGATION: ["com.google.android.apps.maps","com.waze","com.here.app.maps","com.citymapper.app.release"],
};

function startDownload({ categories, count, outputDir, backend, deviceSerial }) {
  const job = createJob();

  if (backend === "google-play") {
    _startGPlayDownload(job, { categories, count, outputDir, deviceSerial });
  } else {
    _startApkPureDownload(job, { categories, count, outputDir });
  }

  return job.id;
}

// ── ApkPure via apkeep ────────────────────────────────────────────────────────

function _startApkPureDownload(job, { categories, count, outputDir }) {
  (async () => {
    fs.mkdirSync(outputDir, { recursive: true });
    const apkeepBin = findBin("apkeep");
    if (!apkeepBin) {
      pushLine(job, "ERROR: apkeep not found. Install with: cargo install apkeep");
      pushLine(job, "       Or download from: https://github.com/EFForg/apkeep/releases");
      return finishJob(job, "apkeep not found");
    }

    for (const catId of categories) {
      if (job.cancelled) break;
      const packages = (SEEDS[catId] || []).slice(0, count);
      if (!packages.length) { pushLine(job, `[SKIP] Unknown category: ${catId}`); continue; }
      pushLine(job, `--- Category: ${catId} (${packages.length} app(s)) ---`);

      const catDir = path.join(outputDir, catId);
      fs.mkdirSync(catDir, { recursive: true });

      for (const pkg of packages) {
        if (job.cancelled) break;
        pushLine(job, `  Downloading: ${pkg}`);
        const pkgDir = path.join(catDir, pkg);
        fs.mkdirSync(pkgDir, { recursive: true });

        // apkeep syntax: apkeep -a <pkg> -d <source> <outpath>
        const ok = await runProcess(job, apkeepBin, ["-a", pkg, "-d", "apk-pure", pkgDir]);
        pushLine(job, ok ? `  [OK] ${pkg}` : `  [FAILED] ${pkg}`);
      }
    }
    finishJob(job);
  })().catch(err => finishJob(job, err.message));
}

// ── Google Play via Appium (Python bridge) ────────────────────────────────────

function _startGPlayDownload(job, { categories, count, outputDir, deviceSerial }) {
  (async () => {
    fs.mkdirSync(outputDir, { recursive: true });

    // Find python3
    const pythonBin = findBin("python3") || findBin("python") || "python3";
    const bridgeScript = path.join(__dirname, "gplay_download.py");

    if (!fs.existsSync(bridgeScript)) {
      pushLine(job, `ERROR: gplay_download.py not found at ${bridgeScript}`);
      return finishJob(job, "bridge script missing");
    }

    // Collect all packages across categories
    const allByCategory = [];
    for (const catId of categories) {
      const packages = (SEEDS[catId] || []).slice(0, count);
      if (packages.length) allByCategory.push({ catId, packages });
    }

    if (!allByCategory.length) {
      pushLine(job, "[WARN] No packages found for selected categories.");
      return finishJob(job);
    }

    for (const { catId, packages } of allByCategory) {
      if (job.cancelled) break;
      pushLine(job, `--- Category: ${catId} (${packages.length} app(s)) via Play Store ---`);
      const catDir = path.join(outputDir, catId);
      fs.mkdirSync(catDir, { recursive: true });

      const args = [bridgeScript, deviceSerial || "", catDir, ...packages];
      const ok = await runProcess(job, pythonBin, args);
      if (!ok && !job.cancelled) pushLine(job, `[WARN] Some downloads may have failed for ${catId}`);
    }

    finishJob(job);
  })().catch(err => finishJob(job, err.message));
}

// ── Log Injection ─────────────────────────────────────────────────────────────

function startInjection({ apkDir, patterns, outputDir }) {
  const job = createJob();

  (async () => {
    // 1. Ensure LogInjector is compiled
    const compiled = await ensureInjectorCompiled(job);
    if (!compiled) return finishJob(job, "Compilation failed");

    // 2. Find android platforms
    const platforms = findAndroidPlatforms();
    if (!platforms) {
      pushLine(job, "ERROR: Android platforms directory not found.");
      pushLine(job, "       Set ANDROID_HOME or install Android SDK.");
      return finishJob(job, "Android platforms not found");
    }
    pushLine(job, `[INFO] Android platforms: ${platforms}`);

    // 3. Scan for APKs
    const { scanApks } = require("./scanner");
    let targets;
    try { targets = scanApks(apkDir); }
    catch (err) { pushLine(job, `ERROR scanning ${apkDir}: ${err.message}`); return finishJob(job, err.message); }

    if (!targets.length) {
      pushLine(job, "No APKs found in the selected directory.");
      return finishJob(job);
    }
    pushLine(job, `Found ${targets.length} APK target(s).`);
    fs.mkdirSync(outputDir, { recursive: true });

    // 4. Build classpath
    const jars = fs.readdirSync(JAR_LIBS_DIR)
      .filter(f => f.endsWith(".jar"))
      .map(f => path.join(JAR_LIBS_DIR, f));
    const cp = [JAVA_SRC_DIR, ...jars].join(":");

    // 5. Inject each target
    for (const target of targets) {
      if (job.cancelled) break;
      pushLine(job, `--- Injecting: ${target.label} ---`);
      pushLine(job, `    Input : ${target.primaryApk}`);

      const appOutDir = path.join(outputDir, target.label.replace(/[^a-zA-Z0-9_-]/g, "_"));
      fs.mkdirSync(appOutDir, { recursive: true });
      pushLine(job, `    Output: ${appOutDir}`);

      // Always pass the primary APK file — Soot does not accept directories.
      // Split libs (config APKs) are copied to the output dir and signed separately.
      const filterCsv = patterns.join(",");

      const javaArgs = [
        "-Xmx8g",
        "-XX:+UseG1GC",
        "-XX:SoftRefLRUPolicyMSPerMB=0",
        "-cp", cp,
        "LogInjector",
        platforms,
        target.primaryApk,
        appOutDir,
      ];
      if (filterCsv) javaArgs.push(filterCsv);

      const javaBin = findBin("java") || "java";
      pushLine(job, `    Cmd: ${javaBin} ${javaArgs.join(" ")}`);
      const ok = await runProcess(job, javaBin, javaArgs);

      if (ok) {
        pushLine(job, `[OK] ${target.label} — output in ${appOutDir}`);

        // Copy split libs (all APKs that aren't the primary) into the output dir
        // so they get zipaligned and signed alongside the injected base APK.
        const splitLibs = target.apkFiles.filter(f => f !== target.primaryApk);
        for (const lib of splitLibs) {
          const dest = path.join(appOutDir, path.basename(lib));
          try {
            fs.copyFileSync(lib, dest);
            pushLine(job, `  Copied split lib: ${path.basename(lib)}`);
          } catch (e) {
            pushLine(job, `  [WARN] Could not copy ${path.basename(lib)}: ${e.message}`);
          }
        }

        // zipalign + sign the injected APK and all split libs
        await signOutputApks(job, appOutDir);
      } else {
        pushLine(job, `[FAILED] ${target.label}`);
      }
    }
    finishJob(job);
  })().catch(err => finishJob(job, err.message));

  return job.id;
}

// Sign APKs produced by Soot using zipalign + apksigner with a debug key
async function signOutputApks(job, outputDir) {
  const zipalign  = findBuildTool("zipalign");
  const apksigner = findBuildTool("apksigner");
  if (!zipalign || !apksigner) {
    pushLine(job, "[WARN] zipalign/apksigner not found — skipping signing. APKs may not install.");
    return;
  }

  // Locate or generate a debug keystore
  const debugKeystore = path.join(os.homedir(), ".android", "debug.keystore");
  const keystoreExists = fs.existsSync(debugKeystore);
  if (!keystoreExists) {
    pushLine(job, "[INFO] Generating debug keystore…");
    spawnSync("keytool", [
      "-genkeypair", "-v", "-keystore", debugKeystore,
      "-alias", "androiddebugkey", "-keyalg", "RSA", "-keysize", "2048",
      "-validity", "10000", "-storepass", "android", "-keypass", "android",
      "-dname", "CN=Android Debug,O=Android,C=US",
    ], { encoding: "utf8" });
  }

  // Find all .apk files in outputDir
  function findApks(dir) {
    let result = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) result = result.concat(findApks(full));
      else if (e.name.toLowerCase().endsWith(".apk")) result.push(full);
    }
    return result;
  }

  const apks = findApks(outputDir);
  if (!apks.length) { pushLine(job, "[INFO] No APKs to sign in output directory."); return; }

  for (const apk of apks) {
    if (job.cancelled) break;
    // Skip APKs that are already intermediate artifacts from a previous run
    if (apk.endsWith("-aligned.apk") || apk.endsWith("-signed.apk")) continue;

    const aligned = apk.replace(/\.apk$/, "-aligned.apk");

    pushLine(job, `  Signing: ${path.basename(apk)}`);

    // zipalign into a temp file
    const zOk = await runProcess(job, zipalign, ["-f", "-v", "4", apk, aligned]);
    if (!zOk) { pushLine(job, `  [WARN] zipalign failed for ${path.basename(apk)}`); continue; }

    // apksigner — sign the aligned file back over the original so the final
    // output contains exactly one copy of each APK, already signed and aligned.
    const sOk = await runProcess(job, apksigner, [
      "sign", "--ks", debugKeystore,
      "--ks-pass", "pass:android",
      "--ks-key-alias", "androiddebugkey",
      "--key-pass", "pass:android",
      "--out", apk, aligned,
    ]);

    try { fs.unlinkSync(aligned); } catch {}  // always clean up the temp file

    if (sOk) {
      pushLine(job, `  [OK] Signed: ${path.basename(apk)}`);
    } else {
      pushLine(job, `  [WARN] apksigner failed for ${path.basename(apk)}`);
    }
  }
}

// Compile only (no injection) — for the "Compile" button
function startCompile() {
  const job = createJob();
  ensureInjectorCompiled(job).then(ok => finishJob(job, ok ? null : "Compilation failed"));
  return job.id;
}

// ── ADB Instrumentation ───────────────────────────────────────────────────────

function startInstrumentation({ apkDir, logDir, deviceSerial }) {
  const job = createJob();

  (async () => {
    const adb = findAdb() || "adb";
    const s = deviceSerial ? ["-s", deviceSerial] : [];

    // Resolve logcat output directory
    const resolvedLogDir = logDir
      ? path.resolve(logDir.replace(/^~/, os.homedir()))
      : path.join(os.homedir(), "MADPro_Logcat");
    try { fs.mkdirSync(resolvedLogDir, { recursive: true }); } catch {}
    pushLine(job, `[INFO] Logcat output directory: ${resolvedLogDir}`);

    // Collect subdirectories (each is one app bundle)
    let subdirs;
    try {
      subdirs = fs.readdirSync(apkDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(apkDir, e.name))
        .sort();
    } catch (err) {
      return finishJob(job, `Cannot read apkDir: ${err.message}`);
    }

    if (!subdirs.length) {
      pushLine(job, "[WARN] No subdirectories found in the selected directory.");
      return finishJob(job);
    }

    pushLine(job, `[INFO] Found ${subdirs.length} app bundle(s) to process.`);

    for (const bundleDir of subdirs) {
      if (job.cancelled) break;

      const bundleName = path.basename(bundleDir);
      pushLine(job, `\n====== ${bundleName} ======`);

      // Collect all APKs in this subdir
      let apks;
      try {
        apks = fs.readdirSync(bundleDir)
          .filter(f => f.toLowerCase().endsWith(".apk"))
          .map(f => path.join(bundleDir, f))
          .sort();
      } catch {
        apks = [];
      }

      if (!apks.length) {
        pushLine(job, `[SKIP] No APKs found in ${bundleName}`);
        continue;
      }

      const baseApk = apks.find(p => path.basename(p).toLowerCase() === "base.apk") || apks[0];
      pushLine(job, `[INFO] APKs: ${apks.map(p => path.basename(p)).join(", ")}`);

      // Install
      let installed;
      if (apks.length > 1) {
        pushLine(job, `[INFO] Using adb install-multiple for ${apks.length} APKs`);
        installed = await runProcess(job, adb, [...s, "install-multiple", "-r", "-t", ...apks]);
      } else {
        installed = await runProcess(job, adb, [...s, "install", "-r", "-t", baseApk]);
      }

      if (!installed) {
        pushLine(job, `[FAILED] Install failed for ${bundleName} — skipping.`);
        continue;
      }
      pushLine(job, `[OK] Installed ${bundleName}`);

      // Extract package name from base APK
      let pkg = null;
      for (const tool of ["aapt2", "aapt"]) {
        try {
          const r = spawnSync(tool, ["dump", "badging", baseApk], { encoding: "utf8", timeout: 15000 });
          const m = (r.stdout || "").match(/^package: name='([^']+)'/m);
          if (m) { pkg = m[1]; break; }
        } catch {}
      }

      if (!pkg) {
        pushLine(job, `[WARN] Could not determine package name for ${bundleName} — skipping launch.`);
        continue;
      }

      // Grant runtime permissions
      pushLine(job, `[INFO] Granting runtime permissions for ${pkg}`);
      const commonDangerousPermissions = [
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
        "android.permission.ACCESS_WIFI_STATE"
      ];

      for (const perm of commonDangerousPermissions) {
        await runProcess(job, adb, [...s, "shell", "pm", "grant", pkg, perm]);
      }
      pushLine(job, `[OK] Runtime permissions granted`);

      // Launch app
      pushLine(job, `[INFO] Launching ${pkg}`);
      await runProcess(job, adb, [...s, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]);

      // Give app a moment to start
      await new Promise(r => setTimeout(r, 1500));

      // Get PID for logcat filtering
      const pidResult = spawnSync(adb, [...s, "shell", "pidof", pkg], { encoding: "utf8" });
      const pid = pidResult.stdout.trim();

      const logcatArgs = pid
        ? [...s, "logcat", "--pid", pid, "-v", "time"]
        : [...s, "logcat", "-v", "time", "-s", "SootInjection:D"];

      const logFile = path.join(resolvedLogDir, bundleName + ".log");
      const logStream = fs.createWriteStream(logFile, { flags: "a" });
      logStream.write(`=== ${new Date().toISOString()} | ${pkg} ===\n`);
      pushLine(job, `[INFO] Streaming logcat to ${logFile}`);

      // Stream logcat for 30 seconds per app, then move on
      await new Promise(resolve => {
        const proc = spawn(adb, logcatArgs);
        job._proc = proc;
        const timeout = setTimeout(() => {
          proc.kill();
        }, 30000);
        const onLine = line => {
          if (line.trim()) {
            pushLine(job, line.trim());
            logStream.write(line + "\n");
          }
        };
        proc.stdout.on("data", d => d.toString().split("\n").forEach(onLine));
        proc.stderr.on("data", d => d.toString().split("\n").forEach(onLine));
        proc.on("close", () => {
          clearTimeout(timeout);
          job._proc = null;
          logStream.end();
          resolve();
        });
        proc.on("error", err => {
          clearTimeout(timeout);
          pushLine(job, `ERROR: ${err.message}`);
          job._proc = null;
          logStream.end();
          resolve();
        });
      });

      // Uninstall before moving to next app
      pushLine(job, `[INFO] Uninstalling ${pkg}`);
      await runProcess(job, adb, [...s, "shell", "pm", "uninstall", pkg]);

      if (job.cancelled) break;
    }

    pushLine(job, `\n[DONE] Finished processing all bundles. Logs saved to ${resolvedLogDir}`);
    finishJob(job);
  })().catch(err => finishJob(job, err.message));

  return job.id;
}

function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.cancelled = true;
  if (job._proc) { try { job._proc.kill("SIGTERM"); } catch {} }
  finishJob(job, "Cancelled");
  return true;
}

module.exports = {
  checkTools,
  listAdbDevices,
  listAvds,
  startDownload,
  startInjection,
  startCompile,
  startInstrumentation,
  cancelJob,
  getJob: (id) => jobs.get(id),
};
