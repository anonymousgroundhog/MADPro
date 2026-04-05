# MADPro — Mobile APK Decompiler & Injector

A desktop GUI tool that uses the [Soot](https://github.com/soot-oss/soot) compiler framework to inject `Log.d` logcat statements into every method of selected Android APK classes. Soot runs inside a Docker container for reproducibility. The main activity for each app is auto-detected from `AndroidManifest.xml` via apktool.

The project also includes a **Node.js web dashboard** (`apk-dashboard/`) for scanning APKs, browsing the Google Play Store, viewing and analyzing logcat output, and chatting with a local AI model (OpenWebUI) about loaded files.

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
| Git | Clone this repo | `sudo apt install git` |
| OpenWebUI (optional) | Local AI model server for AI Chat tab | [openwebui.com](https://openwebui.com/) |

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

These files are large binaries excluded from git. You need:

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

### 4. Build the Docker image

```bash
make build
# or:
docker build -t madpro-injector -f docker/Dockerfile .
```

This builds an image (~1 GB) containing JDK 17, apktool, python3, your Soot JAR and Android platform JARs, and `LogInjector.java` compiled at build time. The first build takes a few minutes; subsequent builds use Docker's layer cache.

### 5. Install the APK dashboard dependencies

```bash
cd apk-dashboard
npm install
cd ..
```

### 6. Run the app

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

The desktop GUI launches the dashboard automatically in its embedded browser tab (requires `tkinterweb`):
```bash
pip3 install tkinterweb
```

---

## APK Dashboard

The dashboard is a self-contained Node.js web app accessible at `http://localhost:3456`. It has six tabs:

### Kanban Board
Drag-and-drop board for tracking APK review status (New → In Progress → Done). APKs are scanned from a configured directory and cards are persisted between sessions.

### Tools
- **APK Scanner** — scan a directory for APKs and view package details
- **Play Store** — search the Google Play Store and view app metadata

### Log Viewer
Load a logcat file and browse log entries with pagination (300 rows at a time). Supports **keyword search** — enter a method name (e.g. `attachInfo`) and it finds all calls to methods containing that name in call-order.

### FSM Analyzer
Load a log file and drop in an FSM model image. Uses the configured AI model (via OpenWebUI) to extract state transitions from the image, then scans the log for violations of the expected state machine order.

### AI Chat
Chat with a local AI model (OpenWebUI) about a loaded log file. Features:
- **File context** — load a log file; its contents are embedded in the first message so the model can answer questions about it
- **Mermaid Viewer** — a side panel for viewing, editing, and rendering Mermaid diagrams from model output
  - **Auto-fix** — attempts to correct common Mermaid syntax errors automatically before rendering
  - **Zoom** — `+`/`-` buttons and `Ctrl+scroll` for zooming; `[ ]` button for fullscreen view
- **Code blocks** — all code in responses has a Copy button; Mermaid blocks also get a "View Diagram" button
- **Model selector** — type a model name in the top bar and click Save to persist it

### Settings
Configure the OpenWebUI connection:
- **URL** — e.g. `http://localhost:3000` or your OpenWebUI server address
- **API Key** — bearer token from OpenWebUI (Settings → Account → API Keys)
- **Model** — model name e.g. `gemma3:latest`, `llama3.2:latest`

Settings are saved to `apk-dashboard/settings.json` (gitignored).

---

## OpenWebUI setup (for AI features)

The AI Chat and FSM Analyzer tabs require a running [OpenWebUI](https://openwebui.com/) instance with at least one model pulled.

**Quick start with Docker:**
```bash
docker run -d -p 3000:3000 \
  -v open-webui:/app/backend/data \
  --name open-webui \
  ghcr.io/open-webui/open-webui:ollama
```

Then open `http://localhost:3000`, create an account, pull a model (e.g. `ollama pull gemma3`), and configure the dashboard Settings tab with:
- URL: `http://localhost:3000`
- API Key: from OpenWebUI → Settings → Account → API Keys
- Model: `gemma3:latest`

---

## Usage — Desktop GUI

1. **Select a directory** — click Browse and pick a folder containing APKs. Subdirectories are scanned recursively.

2. **Review patterns** — each app shows a blue `★` chip for its auto-detected MainActivity. Add additional patterns with the pattern bar.

3. **Patterns** — partial substring match by default. Use `*` as a wildcard:
   - `MainActivity` — matches any class whose name contains "MainActivity"
   - `com.example.*` — matches all classes in that package

4. **Ignore apps** — click **Ignore** to skip an app during injection. Click **Include** to re-enable.

5. **Inject Selected Classes** — runs Soot inside Docker for each active app. Output APKs go to `~/MADPro_Output/`.

6. **APK Kanban Dashboard tab** — embeds the web dashboard directly in the GUI window.

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
    └── settings.json           # Runtime config (gitignored — created on first save)
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
- **Dashboard settings** — `apk-dashboard/settings.json` is gitignored. Copy `apk-dashboard/settings.json.example` if provided, or configure via the Settings tab in the UI.
