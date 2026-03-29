# MADPro — Mobile APK Decompiler & Injector

A desktop GUI tool that uses the [Soot](https://github.com/soot-oss/soot) compiler framework to inject `Log.d` logcat statements into every method of selected Android APK classes. Soot runs inside a Docker container for reproducibility. The main activity for each app is auto-detected from `AndroidManifest.xml` via apktool.

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
| Git | Clone this repo | `sudo apt install git` |

---

## From-scratch setup

### 1. Clone the repository

```bash
git clone https://github.com/your-org/MADPro.git
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
# From Maven Central or the Soot GitHub releases
wget -O jar_libs/soot-4.4.0-jar-with-dependencies.jar \
  https://repo1.maven.org/maven2/ca/mcgill/sable/soot/4.4.0/soot-4.4.0-jar-with-dependencies.jar

wget -O jar_libs/commons-io-2.6.jar \
  https://repo1.maven.org/maven2/commons-io/commons-io/2.6/commons-io-2.6.jar
```

Download Android platform JARs (minimum: android-21 through android-35):

```bash
# Install Android SDK command-line tools, then:
sdkmanager "platforms;android-21" "platforms;android-28" "platforms;android-33" "platforms;android-34" "platforms;android-35"

# Copy the platform JARs into android/platforms/
# Each platform dir needs android.jar inside it, e.g.:
#   android/platforms/android-34/android.jar
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

This builds an image (~1 GB) containing:
- Eclipse Temurin JDK 17
- apktool 2.9.3
- python3 (for manifest parsing)
- Your Soot JAR and Android platform JARs
- `LogInjector.java` compiled at build time

The first build takes a few minutes. Subsequent builds use Docker's layer cache and are near-instant unless you change `LogInjector.java` or `jar_libs/`.

### 5. Run the app

```bash
make run
# or:
python3 main.py
```

---

## Usage

1. **Select a directory** — click Browse and pick a folder containing APKs. Subdirectories are scanned recursively. Split APKs (`base.apk` + `config.*.apk` in the same folder) are grouped as one app.

2. **Review patterns** — each app section shows a blue `★` chip for its auto-detected MainActivity (read from `AndroidManifest.xml`). Add additional patterns with the pattern bar.

3. **Patterns** — partial substring match by default. Use `*` as a wildcard:
   - `MainActivity` — matches any class whose name contains "MainActivity"
   - `com.example.*` — matches all classes in that package
   - `*Login*` — matches anything with "Login" in the name

4. **Ignore apps** — click the **Ignore** button on any app section to skip it during injection. Click **Include** to re-enable it.

5. **Clear All** — removes all pattern chips from all apps.

6. **Inject Selected Classes** — runs Soot inside Docker for each active app. Output APKs are written to the configured output directory (default: `~/MADPro_Output/`).

7. **Open Output** — opens the output directory in your file manager.

---

## Project structure

```
MADPro/
├── main.py                     # Entry point: python3 main.py
├── requirements.txt            # customtkinter, androguard
├── Makefile                    # setup / copy-assets / build / run / clean
├── .gitignore
│
├── docker/
│   ├── Dockerfile              # JDK 17 + apktool + python3 + Soot
│   └── entrypoint.sh           # Routes: inject | get-main-activity
│
├── java/
│   └── LogInjector.java        # Soot BodyTransformer (compiled in Docker)
│
├── jar_libs/                   # ⚠ Not in git — copy via `make copy-assets`
│   ├── soot-4.4.0-*-jar-with-dependencies.jar
│   └── commons-io-2.6.jar
│
├── android/platforms/          # ⚠ Not in git — copy via `make copy-assets`
│   ├── android-21/android.jar
│   └── ...
│
├── core/
│   ├── apk_scanner.py          # Recursive APK discovery + split-APK grouping
│   ├── class_enumerator.py     # DEX class listing (androguard + fallback)
│   ├── docker_runner.py        # subprocess Docker wrapper with live streaming
│   └── injector.py             # Per-app injection orchestration + cleanup
│
├── gui/
│   ├── app.py                  # CustomTkinter entry point
│   ├── main_window.py          # Root window, two-column layout
│   ├── styles.py               # Dark theme colors and fonts
│   └── widgets/
│       ├── apk_directory_picker.py   # Directory browser + APK discovery trigger
│       ├── class_list_panel.py       # Pattern chips + ignore toggle per app
│       ├── action_panel.py           # Inject / Cancel / Build buttons + progress
│       └── log_panel.py             # Colored scrolling output log
│
└── output/                     # Default output (gitignored)
    └── .gitkeep
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
- **Obfuscated APKs** — per-method exceptions are caught and logged as `[SKIP]`; the rest of the APK continues processing.
- **Failed APKs** — if Soot exits with an error, the output directory for that app is automatically deleted so no corrupt APKs are left behind.
- **Output APKs are unsigned** — to install on a device, sign with `apksigner` and align with `zipalign`.
- **Split APKs** — all files in the same directory are passed together to Soot via `-process-dir` so multi-dex and split-resource APKs are handled correctly.
