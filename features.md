# MADPro Feature Comparison

GUI tool: `apk-dashboard/` — Node.js web server (port 3456), browser-based UI  
CLI tool: `command-line-tool/` — `madpro` command, terminal-driven

---

## Shared Features (both tools)

| Feature | GUI | CLI |
|---------|-----|-----|
| **Tool availability check** | Tools tab — shows ✓/✗ for all deps | `madpro check` |
| **ADB device listing** | Tools tab — dropdown populated from `adb devices` + AVDs | `madpro devices` |
| **Download — ApkPure backend** | Tools tab, backend selector | `madpro download -b apkpure` |
| **Download — Google Play backend** | Tools tab, backend selector | `madpro download -b google-play` |
| **Download — Androzoo backend** | Tools tab, SHA256 + API key fields | `madpro download -b androzoo` |
| **Category-based download** | 20-category dropdown (multi-select) | `-c CATEGORY1,CATEGORY2` |
| **Per-category app count** | Numeric input | `-n <count>` |
| **Per-download timeout** | Timeout field (ms) | `-t <ms>` |
| **Google Play browse mode** | Auto-invoked when seed list falls short | Auto-invoked when `countPulled < count` |
| **Skip list reset** | "Clear Failed" button per category | `madpro reset-failed <dir>` |
| **XAPK extraction** | Post-download processing step | Post-download processing step |
| **APK normalization** | Renames main APK → `base.apk` | Renames main APK → `base.apk` |
| **LogInjector compilation** | "Compile" button, force-recompile option | `madpro compile [--force]` |
| **Auto-stale-class detection** | No (manual force only) | Yes — recompiles if `.java` newer than `.class` |
| **Log injection via Soot** | Tools tab inject form | `madpro inject <apk-dir>` |
| **Inject-all mode** | Checkbox | `--inject-all` flag |
| **Method filter patterns** | Text field (CSV) | `-p pattern1,pattern2` |
| **APK zipalign + signing** | Post-inject step (debug keystore) | Post-inject step (debug keystore) |
| **Split APK support** | `adb install-multiple` | `adb install-multiple` |
| **ADB instrumentation** | Tools tab instrument form | `madpro instrument <apk-dir>` |
| **Dangerous permission grant** | 20 permissions, auto-granted | `-g` flag at install — all runtime perms granted automatically |
| **App launch via monkey** | `adb shell monkey` | `adb shell monkey` |
| **Logcat capture to file** | 30 s fixed, streamed to `~/MADPro_Logcat/` | Configurable `--duration`, default 30 s |
| **Bulk uninstall by category** | "Uninstall All" button | `madpro uninstall -c ... -n ...` |
| **Uninstall all Play Store apps** | "Uninstall Play Store Apps" button | `madpro uninstall-playstore` |
| **Signature mismatch handling** | No pre-install uninstall | Pre-install probe + two-tier uninstall |

---

## GUI-Only Features

| Feature | Description |
|---------|-------------|
| **Kanban board** | Drag-and-drop APK pipeline board; scan a directory, enrich with Play Store metadata, move cards through stages |
| **Play Store metadata enrichment** | Fetches app name, developer, rating, category, icon, description for each scanned APK |
| **APK Inspector** | Detailed per-APK panel: permissions list, declared activities/services/receivers, min/target SDK, file size |
| **Manifest Viewer** | Renders `AndroidManifest.xml` with syntax highlighting; shows dangerous permissions summary, package info |
| **Log Viewer** | Browse and paginate `.log` files from instrumentation runs; multi-file view; keyword search across logs |
| **Log search** | Multi-query search across one or multiple log files; highlights matching lines |
| **FSM Analyzer** | Generates a finite-state-machine contract from log data; visualizes as a Mermaid diagram |
| **Ethereum integration** | Deploy FSM contracts as Solidity to a local Ethereum node; push log data on-chain |
| **Jimple viewer** | Run Soot to decompile APK → Jimple IR; browse class list; view per-method CFG (control flow graph); AI-assisted analysis of Jimple |
| **AI Chat tab** | Chat interface backed by OpenWebUI/Ollama; can attach log files or Jimple output as context |
| **Real-time job streaming** | All long-running operations stream output line-by-line to the browser via Server-Sent Events |
| **Job cancellation** | Cancel any running job mid-stream from the UI |
| **Concurrent job limit** | Warns when >2 jobs run simultaneously |
| **Directory browser** | File picker dialogs for selecting APK dirs and output dirs from within the browser |
| **CSV export** | Export Kanban board app list as CSV |
| **JSON export** | Export enriched app list as JSON |
| **Settings persistence** | OpenWebUI URL, API key, model — saved to `settings.json` |
| **Dark/light theme** | Automatic via CSS `prefers-color-scheme` |
| **Model image viewer** | Display a custom FSM model image by path |

---

## CLI-Only Features

| Feature | Description |
|---------|-------------|
| **Configurable logcat duration** | `--duration <ms>` per app (GUI is hardcoded to 30 s) |
| **Stale class auto-detection** | Recompiles LogInjector.java automatically when source is newer than `.class` |
| **Pre-install uninstall** | Detects existing package, uninstalls before install to avoid `INSTALL_FAILED_UPDATE_INCOMPATIBLE`; falls back to `pm uninstall --user 0` for system apps |
| **Dry-run skip list reset** | `--list` flag shows what would be deleted without deleting |
| **Per-category skip list reset** | `-c` flag scopes reset to specific categories only |
| **Scriptable / pipeable** | Exit codes, no browser dependency, composable in shell scripts and CI |
| **Detailed help menu** | `madpro help-menu` — full ASCII reference for every command and option |

---

## Dependency Summary

| Dependency | GUI | CLI |
|-----------|-----|-----|
| Node.js | Required | Required |
| Browser | Required | Not needed |
| apkeep | ApkPure backend | ApkPure backend |
| Python 3 + Appium | Google Play backend | Google Play backend |
| Java / javac | Injection | Injection |
| Android SDK (platforms, build-tools) | Injection + signing | Injection + signing |
| adb | Instrumentation + uninstall | Instrumentation + uninstall |
| aapt / aapt2 | APK scanning | Package name resolution |
| puppeteer | Play Store metadata scraping | Not used |
| curl | Androzoo backend | Androzoo backend |
| Ollama / OpenWebUI | AI Chat tab | Not used |
