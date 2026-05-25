/**
 * commands/help-menu.js
 * `madpro help-menu` — detailed help for all commands.
 */

const CATEGORIES = [
  "GAME_ACTION", "GAME_CASUAL", "GAME_PUZZLE", "GAME_ROLE_PLAYING",
  "SOCIAL", "COMMUNICATION", "PRODUCTIVITY", "ENTERTAINMENT",
  "FINANCE", "HEALTH_AND_FITNESS", "EDUCATION", "MUSIC_AND_AUDIO",
  "NEWS_AND_MAGAZINES", "SHOPPING", "TRAVEL_AND_LOCAL",
  "TOOLS", "PHOTOGRAPHY", "BUSINESS", "MEDICAL", "MAPS_AND_NAVIGATION",
];

const MENU = `
╔══════════════════════════════════════════════════════════════════════╗
║                        MADPro CLI — Help Menu                        ║
╚══════════════════════════════════════════════════════════════════════╝

USAGE
  node index.js <command> [options]
  madpro <command> [options]          (after: npm link)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  check
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Print availability of every required tool: apkeep, java, adb,
  apktool, curl, zipalign, apksigner, Android platforms, jar_libs,
  and LogInjector.class.

  Example:
    madpro check

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  devices
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  List all connected ADB devices (physical + emulators) and locally
  installed AVDs.

  Example:
    madpro devices

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  check-emulator
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Diagnose emulator readiness. Checks and reports on:

    KVM             /dev/kvm exists and is accessible by current user
    Binaries        emulator, sdkmanager, avdmanager present
    Host Vulkan     Vulkan ICD available (required for gfxstream renderer)
    GuestAngle      Explains why API > 35 shows a grey screen and confirms
                    that madpro start-emulator / setup-emulator apply the fix
    System images   Lists all installed system images; flags API > 35 images
                    that need -feature GuestAngle
    AVDs            Lists all AVDs with API level, tag/ABI, and recommended
                    launch flags including GuestAngle where needed

  Known issue documented:
    Emulator 36.x disables GuestAngle for API > 35 by default, causing a
    solid grey screen. Fix: pass -feature GuestAngle at launch.
    All madpro emulator commands apply this automatically.

  Example:
    madpro check-emulator

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  setup-emulator  <avd-name>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Download a system image (if not already installed), create a new AVD
  (or wipe and recreate an existing one with --fresh), then boot it and
  wait until fully ready.

  Options:
    --fresh             Delete existing AVD and recreate from scratch
    --api <level>       Android API level                              [35]
    --tag <tag>         google_apis_playstore | google_apis | default  [google_apis_playstore]
    --abi <abi>         x86_64 | arm64-v8a                             [x86_64]
    --device <type>     Hardware profile (avdmanager --list device)    [pixel_6]
    --sdcard <mb>       SD card size in MB                             [2048]
    --gpu <mode>        auto | host | swiftshader_indirect | off       [host]
    --headless          No window (forces swiftshader_indirect)
    --no-boot           Create AVD but do not boot it
    --timeout <ms>      Max boot wait time                             [180000]

  Examples:
    # Create a fresh Play Store AVD on API 35 and boot it
    madpro setup-emulator MyResearchAVD

    # Recreate an existing AVD from scratch (wipes all data)
    madpro setup-emulator MyResearchAVD --fresh

    # API 34 google_apis image, headless boot
    madpro setup-emulator Research_34 --api 34 --tag google_apis --headless

    # Create only, no boot
    madpro setup-emulator Research_35 --no-boot

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  start-emulator  [avd-name]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Launch an Android AVD emulator and wait until it is fully booted.
  Omit [avd-name] to list available AVDs.

  Options:
    --no-snapshot       Cold boot — ignore saved snapshot
    --wipe-data         Wipe userdata partition before boot
    --gpu <mode>        GPU mode: auto | host | swiftshader_indirect | off  [host]
    --headless          No window (forces swiftshader_indirect GPU)
    --timeout <ms>      Max time to wait for boot                           [120000]

  Examples:
    # List available AVDs
    madpro start-emulator

    # Start an AVD and wait for boot
    madpro start-emulator Pixel_6_API_34

    # Headless (CI / no display)
    madpro start-emulator Pixel_6_API_34 --headless

    # Cold boot, wipe data
    madpro start-emulator Pixel_6_API_34 --no-snapshot --wipe-data

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  download
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Download APKs from one of three backends:

  ┌─ apkpure (default) ─────────────────────────────────────────────┐
  │ Uses apkeep CLI (https://github.com/EFForg/apkeep).             │
  │ No Google account required.                                      │
  │                                                                  │
  │ Install apkeep first:                                            │
  │   cargo install apkeep                                           │
  │   — or — download a prebuilt binary from the releases page.     │
  │                                                                  │
  │ Examples:                                                        │
  │   madpro download -c SOCIAL,FINANCE -n 5 -o ./apks              │
  │   madpro download -c GAME_ACTION -n 10 -o ./apks -t 120000      │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ google-play ───────────────────────────────────────────────────┐
  │ Downloads APKs directly from the Google Play Store by driving   │
  │ a real Android device (or emulator) via Appium + ADB.           │
  │                                                                  │
  │ Requirements:                                                    │
  │   1. Appium server:                                              │
  │        npm install -g appium                                     │
  │        appium driver install uiautomator2                        │
  │   2. A connected Android device or running emulator             │
  │        (must be signed in to a Google account in Play Store)    │
  │   3. ADB in PATH or ANDROID_HOME set                            │
  │   4. Python 3 + project pip deps:                               │
  │        pip install -r requirements.txt                           │
  │                                                                  │
  │ How it works:                                                    │
  │   - Resolves package names from Play Store top charts           │
  │     (falls back to built-in seed lists if scrape fails)         │
  │   - Appium navigates the Play Store UI, taps Install            │
  │   - ADB pulls each installed APK off the device into            │
  │     <output>/<category>/google_play/<package>/base.apk          │
  │   - XAPK bundles are extracted and normalised automatically     │
  │                                                                  │
  │ Examples:                                                        │
  │   # List devices first                                           │
  │   madpro devices                                                 │
  │                                                                  │
  │   # Download via Play Store on a specific device                 │
  │   madpro download -b google-play \\                              │
  │     -c SOCIAL,COMMUNICATION \\                                   │
  │     -n 5 \\                                                      │
  │     -d emulator-5554 \\                                          │
  │     -o ./apks                                                    │
  │                                                                  │
  │   # Omit -d to use the first connected device                   │
  │   madpro download -b google-play -c PRODUCTIVITY -n 3 -o ./apks │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ androzoo ──────────────────────────────────────────────────────┐
  │ Downloads APKs by SHA256 hash from the Androzoo research        │
  │ dataset (https://androzoo.uni.lu). Requires an API key.         │
  │                                                                  │
  │ Get an API key: https://androzoo.uni.lu/access                  │
  │                                                                  │
  │ Examples:                                                        │
  │   madpro download -b androzoo \\                                 │
  │     --api-key YOUR_KEY \\                                        │
  │     --sha256 HASH1,HASH2,HASH3 \\                               │
  │     -o ./apks                                                    │
  └──────────────────────────────────────────────────────────────────┘

  Options (all backends unless noted):
    -b, --backend <name>      apkpure | google-play | androzoo  [apkpure]
    -c, --categories <list>   Comma-separated category IDs      [GAME_ACTION]
    -n, --count <n>           Apps per category                 [5]
    -o, --output <dir>        Output directory                  [./apks]
    -d, --device <serial>     ADB device serial (google-play)
    -t, --timeout <ms>        Per-download timeout, 0=none      [0]
    --api-key <key>           Androzoo API key
    --sha256 <hashes>         Comma-separated SHA256s (androzoo)

  Available categories:
    ${CATEGORIES.join(", ")}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  reset-failed  <output-dir>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  During a google-play download, every app that fails to install,
  is incompatible, paid, or times out is recorded in a hidden file:

    <output>/<CATEGORY>/google_play/.skip_list.json

  On subsequent runs the downloader reads this file and silently skips
  those packages — which is efficient for re-runs but means a genuinely
  transient failure (network blip, device reboot) will never be retried
  until the file is cleared.

  reset-failed finds and deletes all .skip_list.json files so every
  previously-skipped package is attempted again on the next download.

  Options:
    -c, --categories <list>   Only reset specific categories (comma-separated).
                              Omit to reset every category in the output dir.
    --list                    Dry run — print what would be deleted, no changes.

  What each entry in .skip_list.json looks like:
    {
      "com.example.app": {
        "reason": "price: $4.99",
        "ts": 1716571234
      }
    }

  Reasons you may see:
    price: ...          app is paid — won't change, safe to leave skipped
    skip phrase: ...    "not available" / "incompatible" on this device
    install_timeout     install took too long — worth retrying
    pull_failed         APK pulled but adb pull failed — worth retrying
    no_button_found     Play Store page didn't render — worth retrying
    deeplink_failed     Appium couldn't open the store page — worth retrying
    exception: ...      unexpected error — worth retrying

  Examples:
    # See what would be cleared (dry run)
    madpro reset-failed /media/sean/MyDrive/APKs --list

    # Reset everything in the output dir
    madpro reset-failed /media/sean/MyDrive/APKs

    # Reset only specific categories
    madpro reset-failed /media/sean/MyDrive/APKs -c PRODUCTIVITY,SOCIAL

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  compile
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Compile LogInjector.java against the Soot jars in jar_libs/.
  Run this once before your first injection. Inject also runs it
  automatically if the .class is missing.

  Options:
    --force   Recompile even if LogInjector.class already exists

  Example:
    madpro compile
    madpro compile --force

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  inject  <apk-dir>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Instrument APKs using Soot (LogInjector). Automatically compiles
  LogInjector if needed, then injects logging stubs, zipaligns, and
  signs the output with a debug keystore.

  For each app found in <apk-dir>:
    1. Run LogInjector via java -cp jar_libs/* LogInjector
    2. Copy split APKs alongside the injected base
    3. zipalign + apksigner with ~/.android/debug.keystore

  Options:
    -o, --output <dir>        Output directory                        [./injected]
    -p, --patterns <csv>      Method class filter patterns passed to  (empty = all)
                              LogInjector (e.g. "onCreate,onResume")
    --pkg-filter <globs>      Comma-separated glob/substring patterns to select
                              which APKs to inject by path or label.
                              Use this when pointing at a large collection to
                              avoid scanning every APK.
                              Examples: "*/SOCIAL/*"  "com.instagram*"
    --inject-all              Inject all methods (no method filter)
    --force-compile           Force recompile LogInjector.java before injecting

  Examples:
    # Inject all APKs in a directory, all methods
    madpro inject ./apks -o ./injected --inject-all

    # Inject only APKs whose path contains "SOCIAL" or "FINANCE"
    madpro inject /media/sean/APKs -o ./injected --inject-all \\
      --pkg-filter "*/SOCIAL/*,*/FINANCE/*"

    # Inject all APKs but only instrument onCreate and onResume methods
    madpro inject ./apks -o ./injected -p "onCreate,onResume"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  instrument  <apk-dir>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  For each subdirectory of injected APKs:
    1. adb install (or install-multiple for split APKs)
    2. Grant all dangerous permissions automatically
    3. Launch app via adb shell monkey
    4. Stream logcat output to <log-dir>/<app>.log  (default 30 s)
    5. adb uninstall before moving to the next app

  Options:
    -l, --log-dir <dir>     Where to save .log files  [~/MADPro_Logcat]
    -d, --device <serial>   ADB device serial
    --duration <ms>         Logcat capture time per app  [30000]

  Examples:
    madpro instrument ./injected -d emulator-5554
    madpro instrument ./injected -d emulator-5554 --duration 60000 -l ./logs

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  uninstall
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Uninstall apps matching the seed list for selected categories.
  Skips packages not present on device.

  Options:
    -c, --categories <list>   Categories to resolve    [GAME_ACTION]
    -n, --count <n>           Apps per category        [10]
    -d, --device <serial>     ADB device serial

  Example:
    madpro uninstall -c SOCIAL,FINANCE -n 5 -d emulator-5554

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  uninstall-playstore
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Uninstall every app whose installer is com.android.vending
  (i.e. everything installed via the Play Store).

  Options:
    -d, --device <serial>   ADB device serial

  Example:
    madpro uninstall-playstore -d emulator-5554

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  TYPICAL WORKFLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # 1. Verify tools
  madpro check

  # 2. Download APKs
  madpro download -b apkpure -c SOCIAL,FINANCE -n 5 -o ./apks

  # 3. Compile injector (once)
  madpro compile

  # 4. Inject logging
  madpro inject ./apks -o ./injected --inject-all

  # 5. Check device
  madpro devices

  # 6. Run on device, capture logs
  madpro instrument ./injected -d emulator-5554 --duration 60000

  # 7. Clean up device
  madpro uninstall-playstore -d emulator-5554

`;

function register(program) {
  program
    .command("help-menu")
    .description("Show detailed help for all commands")
    .action(() => {
      console.log(MENU);
    });
}

module.exports = { register };
