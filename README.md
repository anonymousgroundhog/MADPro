# MADPro — Mobile APK Decompiler & Injector

A desktop GUI tool that uses the [Soot](https://github.com/soot-oss/soot) compiler framework to inject `Log.d` logcat statements into every method of selected Android APK classes. Soot runs inside a Docker container for reproducibility. The main activity for each app is auto-detected from `AndroidManifest.xml` via apktool.

The project also includes a **Node.js web dashboard** (`apk-dashboard/`) for scanning APKs, browsing the Google Play Store, viewing and analyzing logcat output, decompiling APKs to Jimple IR, deploying FSM smart contracts to a local Ethereum testnet, and chatting with a local AI model (OpenWebUI).

## Output log format

Every instrumented method emits this logcat line on entry:

```
D SootInjection: Entering method: <com.example.MyClass: void onCreate(android.os.Bundle)>
```

---

## Prerequisites

Install the following before starting:

| Dependency | Purpose | Install |
|---|---|---|
| Docker | Runs Soot + apktool in an isolated container | [docs.docker.com](https://docs.docker.com/get-docker/) |
| Python 3.10+ | GUI runtime | `sudo apt install python3 python3-pip` |
| python3-tk | Tkinter GUI backend | `sudo apt install python3-tk` |
| Node.js 18+ | APK dashboard web server | [nodejs.org](https://nodejs.org/) |
| Java 11+ | Runs Soot locally for Jimple decompiler tab | `sudo apt install default-jdk` |
| Git | Clone this repo | `sudo apt install git` |
| OpenWebUI (optional) | Local AI model server for AI Chat + FSM tabs | [openwebui.com](https://openwebui.com/) |
| Ganache (optional) | Local Ethereum testnet for FSM contract tab | `npm install -g ganache` |

---

## From-scratch setup

### 1. Clone the repository

```bash
git clone https://github.com/anonymousgroundhog/MADPro.git
cd MADPro
```

### 2. Install Python dependencies

```bash
pip3 install -r requirements.txt
```

If you get a `No module named 'tkinter'` error:

```bash
sudo apt install python3-tk
```

### 3. Get the Soot JAR and Android platform JARs

These files are large binaries excluded from git. You need them for both the Docker-based log injector and the Jimple Decompiler tab.

**Option A — copy from MADScanner_AI** (if you have that repo alongside this one):

```bash
make copy-assets
```

This copies from `../MADScanner_AI/Jar_Libs/` and `../MADScanner_AI/Android/platforms/`.

**Option B — download manually:**

```bash
mkdir -p jar_libs android/platforms
```

Download the Soot fat JAR:

```bash
wget -O jar_libs/soot-4.4.0-jar-with-dependencies.jar \
  https://repo1.maven.org/maven2/ca/mcgill/sable/soot/4.4.0/soot-4.4.0-jar-with-dependencies.jar

wget -O jar_libs/commons-io-2.6.jar \
  https://repo1.maven.org/maven2/commons-io/commons-io/2.6/commons-io-2.6.jar
```

Download Android platform JARs (minimum: android-21 through android-35):

```bash
sdkmanager "platforms;android-21" "platforms;android-28" "platforms;android-33" "platforms;android-34" "platforms;android-35"

cp -r ~/Android/Sdk/platforms/* android/platforms/
```

Your `android/platforms/` should look like:

```
android/platforms/
├── android-21/android.jar
├── android-28/android.jar
├── android-33/android.jar
├── android-34/android.jar
└── android-35/android.jar
```

### 4. Set up Soot JARs for the dashboard Jimple tab

The dashboard's Jimple Decompiler tab runs Soot directly via `java` (no Docker). The required JARs are bundled in `apk-dashboard/soot_jar/`:

```
apk-dashboard/soot_jar/
├── soot-4.4.0-20220321.130129-1-jar-with-dependencies.jar
├── commons-io-2.6.jar
└── polyglot-2006.jar
```

If the `soot_jar/` directory is missing or empty, download the JARs manually:

```bash
mkdir -p apk-dashboard/soot_jar

wget -O apk-dashboard/soot_jar/soot-4.4.0-20220321.130129-1-jar-with-dependencies.jar \
  "https://repo1.maven.org/maven2/ca/mcgill/sable/soot/4.4.0-20220321.130129-1/soot-4.4.0-20220321.130129-1-jar-with-dependencies.jar"

wget -O apk-dashboard/soot_jar/commons-io-2.6.jar \
  "https://repo1.maven.org/maven2/commons-io/commons-io/2.6/commons-io-2.6.jar"

wget -O apk-dashboard/soot_jar/polyglot-2006.jar \
  "https://repo1.maven.org/maven2/ca/mcgill/sable/polyglot/2006/polyglot-2006.jar"
```

Java 11 or later must be on your `PATH`. Verify with:

```bash
java -version
```

### 5. Build the Docker image

```bash
make build
# or:
docker build -t madpro-injector -f docker/Dockerfile .
```

This builds an image (~1 GB) containing JDK 17, apktool, python3, your Soot JAR and Android platform JARs, and `LogInjector.java` compiled at build time. The first build takes a few minutes; subsequent builds use Docker's layer cache.

### 6. Install the APK dashboard dependencies

```bash
cd apk-dashboard
npm install
cd ..
```

This installs all Node.js dependencies including `solc` (Solidity compiler for the FSM Contract tab) and `puppeteer` (for Play Store scraping).

### 7. Run the app

**Desktop GUI:**
```bash
make run
# or:
python3 main.py
```

**APK Dashboard (web UI):**
```bash
cd apk-dashboard
node server.js --port 3456
# then open http://localhost:3456
```

Optional flags:
```bash
node server.js --dir /path/to/apks --port 3456
#   --dir    pre-load a directory of APKs on startup
#   --port   listen port (default 3456)
```

The desktop GUI launches the dashboard automatically in its embedded browser tab (requires `tkinterweb`):
```bash
pip3 install tkinterweb
```

---

## APK Dashboard

The dashboard is a self-contained Node.js web app accessible at `http://localhost:3456`. It has seven tabs:

### Kanban Board
Drag-and-drop board for tracking APK review status. APKs are scanned from a configured directory and cards are persisted between sessions. Click **Browse** in the top bar to point it at a directory of APKs, then click **Scan**.

### Tools
- **APK Scanner** — scan a directory for APKs and view package details, permissions, and Play Store metadata
- **Play Store** — search Google Play and view app metadata, ratings, and category
- **Download APKs** — download APKs directly via a connected Android device (`adb`) or emulator
- **Instrumentation** — inject logcat statements into APK methods via the Soot Docker container

### Log Viewer
Load a logcat file and browse log entries with pagination (300 rows at a time). Key features:
- **App filter** — select a specific app package to filter entries
- **Keyword search** — enter method names (e.g. `attachInfo,onAdLoaded`) and find all calls in call-sequence order
- **⛓ Generate FSM Contract** — uses an AI model to generate a Solidity FSM smart contract from the loaded log + keyword search results, then deploy it to Ganache
- **⬆ Push Data to Contract** — pushes the filtered call sequence to a deployed FSM contract via `recordTransition(pkg, method)`

### FSM Analyzer
Load a log file and drop in an FSM model image. Uses the configured AI model to extract state transitions from the image, then scans the log for violations of the expected state machine order.

### Jimple Decompiler
Decompile an Android APK to Jimple intermediate representation (IR) using [Soot](https://github.com/soot-oss/soot), then browse and read the output files with syntax highlighting. Requires Java on `PATH` and the `soot_jar/` directory to be populated (see setup step 4).

**Workflow:**
1. Enter the APK path and output directory, then click **Run Soot**
2. Watch the live output log as Soot processes each class
3. Once complete, the output directory auto-loads in the file viewer
4. Select any `.jimple` file from the list to view its decompiled code
5. Click **❓ Help** for a guide to reading Jimple syntax

**Android Platforms Dir** — optional but recommended. Without it Soot may fail to resolve Android framework classes. Point it at `~/Android/Sdk/platforms` or wherever your SDK is installed.

### AI Chat
Chat with a local AI model (OpenWebUI) about a loaded log file. Features:
- **File context** — load a log file; its contents are embedded in the first message
- **Mermaid Viewer** — side panel for viewing and editing Mermaid diagrams from model output, with auto-fix, zoom, and fullscreen view
- **Code blocks** — all code in responses has a Copy button; Mermaid blocks also get a "View Diagram" button
- **Model selector** — type a model name in the top bar and click Save to persist it

### Settings
Configure the OpenWebUI connection:
- **URL** — e.g. `http://localhost:3000`
- **API Key** — bearer token from OpenWebUI (Settings → Account → API Keys)
- **Model** — model name e.g. `gemma3:latest`, `llama3.2:latest`

Settings are saved to `apk-dashboard/settings.json` (gitignored).

---

## OpenWebUI setup (for AI features)

The AI Chat, FSM Analyzer, and FSM Contract Generator tabs require a running [OpenWebUI](https://openwebui.com/) instance with at least one model pulled.

**Quick start with Docker:**
```bash
docker run -d -p 3000:3000 \
  -v open-webui:/app/backend/data \
  --name open-webui \
  ghcr.io/open-webui/open-webui:ollama
```

Then open `http://localhost:3000`, create an account, pull a model (e.g. `ollama pull gemma3`), and configure the dashboard Settings tab:
- URL: `http://localhost:3000`
- API Key: from OpenWebUI → Settings → Account → API Keys
- Model: `gemma3:latest`

---

## Ganache setup (for FSM Contract tab)

The FSM Contract features (Generate, Deploy, Push Data) require a running [Ganache](https://trufflesuite.com/ganache/) Ethereum testnet.

**Install and run Ganache CLI:**
```bash
npm install -g ganache
ganache --port 7545
```

The dashboard connects to `http://127.0.0.1:7545` by default. This can be changed in the FSM Contract modal under **Ganache URL**.

**What the FSM Contract tab does:**
1. **Generate** — sends log data + keyword call sequence to the AI model to produce a Solidity `FSMViolationAuditor` contract, or click **Load Default** for the built-in reference contract
2. **Deploy** — compiles the contract with `solc` (targeting the London EVM for Ganache 7.x compatibility) and deploys it to the selected Ganache account
3. **Push Data** — encodes and sends `recordTransition(pkg, method)` calls to the deployed contract for each entry in the keyword call sequence

> **Note:** The generated contract uses `pragma solidity ^0.8.0` and targets the London EVM (`evmVersion: "london"`). Ganache 7.9.x does not support newer EVM versions (e.g. Cancun/Osaka opcodes) and will reject contracts compiled for them.

---

## Project structure

```
MADPro/
├── main.py                     # Entry point: python3 main.py
├── requirements.txt            # customtkinter, androguard, tkinterweb
├── Makefile
├── .gitignore
│
├── docker/
│   ├── Dockerfile              # JDK 17 + apktool + python3 + Soot
│   └── entrypoint.sh
│
├── java/
│   └── LogInjector.java        # Soot BodyTransformer
│
├── jar_libs/                   # NOT in git — copy via `make copy-assets`
├── android/platforms/          # NOT in git — copy via `make copy-assets`
│
├── core/
│   ├── apk_scanner.py
│   ├── class_enumerator.py
│   ├── docker_runner.py
│   └── injector.py
│
├── gui/
│   ├── app.py
│   ├── main_window.py
│   ├── styles.py
│   └── widgets/
│       ├── apk_directory_picker.py
│       ├── class_list_panel.py
│       ├── action_panel.py
│       └── log_panel.py
│
├── views/
│   └── dashboard_view.py       # Embedded dashboard tab (tkinterweb)
│
└── apk-dashboard/              # Node.js web dashboard
    ├── server.js               # Single-file HTTP server + all routes + HTML
    ├── package.json
    ├── scanner.js              # APK scanning logic
    ├── playstore.js            # Play Store scraping
    ├── gplay_download.py       # Play Store download helper
    ├── tools-api.js            # Tools API routes
    ├── apk_inspector.js        # APK inspection utilities
    ├── settings.json           # Runtime config (gitignored — created on first save)
    └── soot_jar/               # Soot + helper JARs for Jimple decompiler tab
        ├── soot-4.4.0-*.jar
        ├── commons-io-2.6.jar
        └── polyglot-2006.jar
```

---

## Makefile targets

| Target | Description |
|---|---|
| `make setup` | Install Python dependencies |
| `make copy-assets` | Copy Soot JARs + Android platforms from `../MADScanner_AI` |
| `make build` | Build the `madpro-injector` Docker image |
| `make run` | Launch the GUI |
| `make clean` | Remove Docker image and Python cache |

---

## Notes

- **Injection is sequential** — Soot uses 4–25 GB RAM per APK; parallel runs would OOM.
- **Obfuscated APKs** — per-method exceptions are caught and logged as `[SKIP]`; processing continues.
- **Failed APKs** — if Soot exits non-zero, the output directory is deleted so no corrupt APKs remain.
- **Output APKs are unsigned** — sign with `apksigner` and align with `zipalign` before installing.
- **Split APKs** — all files in the same directory are passed together to Soot so multi-dex and split-resource APKs are handled correctly.
- **Dashboard settings** — `apk-dashboard/settings.json` is gitignored. Configure via the Settings tab in the UI; the file is created on first save.
- **Jimple output size** — a large APK can produce thousands of `.jimple` files. Use the search filter in the file viewer to find classes quickly.
- **Ganache nonce handling** — the dashboard re-fetches the pending nonce after any failed transaction so nonce drift does not stall a batch push.
