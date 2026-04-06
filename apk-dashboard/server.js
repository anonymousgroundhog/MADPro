/**
 * server.js — APK Kanban Dashboard
 * Run: node server.js [--dir /path/to/apks] [--port 3456]
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { scanApks } = require("./scanner");
const { lookupPlayStore, clearCache } = require("./playstore");
const { inspectApk } = require("./apk_inspector");
const { getManifestSummary, DANGEROUS_PERMISSIONS } = require("./manifest_extractor");
const puppeteer = require("puppeteer");
const toolsApi = require("./tools-api");

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let APK_DIR = null;
let PORT = 3456;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir" && args[i + 1]) APK_DIR = path.resolve(args[++i]);
  if (args[i] === "--port" && args[i + 1]) PORT = parseInt(args[++i], 10);
}

// ── Settings (persisted to disk) ────────────────────────────────────────────

const SETTINGS_PATH = path.join(__dirname, "settings.json");

const DEFAULT_SETTINGS = {
  openwebui_url: "http://localhost:3000",
  openwebui_key: "",
  openwebui_model: "",
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(obj) {
  const current = loadSettings();
  const merged = { ...current, ...obj };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

// ── In-memory state ─────────────────────────────────────────────────────────

let state = {
  dir: APK_DIR,
  scanning: false,
  enriching: false,
  progress: { done: 0, total: 0 },
  apps: [],
  error: null,
};

// ── Scan + enrich pipeline ──────────────────────────────────────────────────

async function runScan(dir) {
  clearCache(); // always fetch fresh Play Store data on each scan
  state.dir = dir;
  state.scanning = true;
  state.enriching = false;
  state.error = null;
  state.apps = [];
  state.progress = { done: 0, total: 0 };

  // Check if directory has a very large number of entries
  let immediateEntries = 0;
  try {
    immediateEntries = fs.readdirSync(dir).length;
  } catch {}

  if (immediateEntries > 1000) {
    state.warning = `⚠ Large directory detected (${immediateEntries} entries). Limiting recursion depth for performance.`;
  }

  let scanned;
  try {
    scanned = scanApks(dir);
  } catch (err) {
    state.error = err.message;
    state.scanning = false;
    return;
  }

  state.scanning = false;
  state.enriching = true;
  state.progress = { done: 0, total: scanned.length };

  state.apps = scanned.map((app) => ({ ...app, storeData: null }));

  const pkgToApps = new Map();
  for (const app of state.apps) {
    if (!app.package) continue;
    if (!pkgToApps.has(app.package)) pkgToApps.set(app.package, []);
    pkgToApps.get(app.package).push(app);
  }

  const uniquePkgs = [...pkgToApps.keys()];
  let done = 0;
  const CONCURRENCY = 3;
  const queue = [...uniquePkgs];

  async function worker() {
    while (queue.length > 0) {
      const pkg = queue.shift();
      if (!pkg) continue;
      const sd = await lookupPlayStore(pkg);
      const apps = pkgToApps.get(pkg) || [];

      if (!sd.stillOnStore) {
        // Not on Play Store — fall back to static APK inspection
        for (const app of apps) {
          try {
            const scan = inspectApk(app.primaryApk);
            app.storeData = {
              ...sd,
              hasAds: scan.hasAds,
              adSdks: scan.adSdks,
              hasPlayStoreTraces: scan.hasPlayStoreTraces,
              playStoreTraces: scan.playStoreTraces,
              scanMethod: "apk-scan",
            };
          } catch {
            app.storeData = { ...sd, scanMethod: "apk-scan-failed" };
          }
        }
      } else {
        for (const app of apps) {
          app.storeData = { ...sd, scanMethod: "play-store" };
          if (sd.appName) app.appName = sd.appName;
        }
      }

      done++;
      state.progress.done = done;
    }
  }

  // Mark apps without a package as done immediately
  for (const app of state.apps) {
    if (!app.package) {
      app.storeData = { appName: null, rating: null, downloads: null, hasAds: null, storeUrl: null, stillOnStore: false, scanMethod: "no-package" };
      done++;
      state.progress.done = done;
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, uniquePkgs.length || 1) }, worker);
  await Promise.all(workers);

  state.enriching = false;
  state.progress.done = state.apps.length;
}

// ── Directory browser ───────────────────────────────────────────────────────

function listDir(dirPath) {
  const abs = path.resolve(dirPath);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(abs);
  return {
    current: abs,
    parent: parent !== abs ? parent : null,
    dirs,
    home: os.homedir(),
  };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonResponse(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function htmlResponse(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// Extract app package names from a logcat file using nativeloader lines.
// Pattern: /data/app/~~...==/com.foo.bar-XXXX==/  → package is "com.foo.bar"
const NATIVELOADER_PKG_RE = /\/data\/app\/~~[^/]+\/([a-zA-Z][a-zA-Z0-9_.]*)-[A-Za-z0-9_]+=+=\//g;
function extractAppPackages(content) {
  const found = new Set();
  let m;
  NATIVELOADER_PKG_RE.lastIndex = 0;
  while ((m = NATIVELOADER_PKG_RE.exec(content)) !== null) {
    found.add(m[1]);
  }
  return [...found];
}

// Parse a logcat file and return all SootInjection entries
function parseLogEntries(absPath) {
  const content = fs.readFileSync(absPath, "utf8");
  const MARKER = "Entering method: ";
  const SIG_RE = /^<(.+):\s+(\S+)\s+([^(]+)\(([^)]*)\)>$/;
  const entries = [];
  const seen = new Set();
  for (const line of content.split("\n")) {
    const idx = line.indexOf(MARKER);
    if (idx === -1) continue;
    const sig = line.slice(idx + MARKER.length).trim();
    const m = SIG_RE.exec(sig);
    if (m) {
      const className  = m[1].trim();
      const returnType = m[2].trim();
      const methodName = m[3].trim();
      const args       = m[4].trim();
      const key = className + "#" + methodName + "(" + args + ")";
      entries.push({ className, returnType, methodName, args, sig, key, duplicate: seen.has(key) });
      seen.add(key);
    } else {
      entries.push({ className: null, returnType: null, methodName: null, args: null, sig, key: sig, duplicate: false });
    }
  }
  return entries;
}

// Match a single log entry against a cleaned query string (case-insensitive).
// Query is the cleaned keyword + "(" e.g. "onCreate("
// Matches against methodName + "(" so partial method names work.
function entryMatchesQuery(e, queryLow) {
  if (e.methodName) {
    const mn = (e.methodName + "(").toLowerCase();
    if (mn.indexOf(queryLow) !== -1) return true;
  }
  // Fallback: check full sig for raw entries
  if (e.sig && e.sig.toLowerCase().indexOf(queryLow) !== -1) return true;
  return false;
}

// ── HTML ────────────────────────────────────────────────────────────────────

function renderHtml() {
  const initDir = APK_DIR || os.homedir();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>MADPro</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --card-bg: #22263a;
    --card-border: #2e3355;
    --accent-ads: #e04a4a;
    --accent-no-ads: #3cb878;
    --accent-unknown: #7a8099;
    --text: #e8eaf6;
    --text-muted: #8a90aa;
    --text-link: #7eb6ff;
    --badge-bg: #2e3355;
    --radius: 10px;
    --shadow: 0 2px 12px rgba(0,0,0,0.45);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; min-height: 100vh; }

  /* ── Header ── */
  header {
    background: var(--surface);
    border-bottom: 1px solid var(--card-border);
    padding: 16px 24px;
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  }
  header h1 { font-size: 1.35rem; font-weight: 700; white-space: nowrap; }
  header h1 span { color: var(--accent-no-ads); }

  .dir-row { display: flex; gap: 8px; flex: 1; min-width: 200px; align-items: center; }
  .dir-row input {
    flex: 1; background: var(--card-bg); border: 1px solid var(--card-border);
    color: var(--text); padding: 8px 12px; border-radius: 6px; font-size: .88rem;
    min-width: 0;
  }
  .dir-row input:focus { outline: 2px solid var(--accent-no-ads); }
  .btn-browse {
    background: var(--card-bg); color: var(--text-link); border: 1px solid var(--card-border);
    padding: 8px 13px; border-radius: 6px; font-size: .88rem; cursor: pointer; white-space: nowrap;
    transition: background .15s;
  }
  .btn-browse:hover { background: #2a2f4a; }
  .btn-scan {
    background: var(--accent-no-ads); color: #fff; border: none;
    padding: 8px 18px; border-radius: 6px; font-size: .88rem; cursor: pointer; font-weight: 700;
    white-space: nowrap; transition: opacity .15s;
  }
  .btn-scan:hover { opacity: .85; }
  .btn-scan:disabled { opacity: .45; cursor: default; }

  /* ── Status bar ── */
  .status-bar {
    font-size: .82rem; color: var(--text-muted);
    background: var(--surface); padding: 6px 24px;
    border-bottom: 1px solid var(--card-border);
    display: flex; align-items: center; gap: 8px;
  }
  .status-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent-unknown); flex-shrink: 0;
  }
  .status-bar.scanning .status-dot { background: #f5a623; animation: pulse 1s infinite; }
  .status-bar.enriching .status-dot { background: var(--text-link); animation: pulse 1s infinite; }
  .status-bar.done .status-dot { background: var(--accent-no-ads); }
  .status-bar.error .status-dot { background: var(--accent-ads); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }

  /* ── Tab navigation ── */
  .tab-nav { display: flex; gap: 4px; padding: 12px 24px 0; border-bottom: 1px solid var(--card-border); background: var(--bg); }
  .tab-btn {
    background: transparent; border: 1px solid transparent; color: var(--text-muted);
    padding: 7px 18px; border-radius: 6px 6px 0 0; font-size: .88rem; font-weight: 600;
    cursor: pointer; border-bottom: none; transition: color .15s, background .15s;
    margin-bottom: -1px;
  }
  .tab-btn:hover { color: var(--text); background: var(--surface); }
  .tab-btn.active { color: var(--text); background: var(--surface); border-color: var(--card-border); border-bottom-color: var(--surface); }

  /* ── Tools tab layout ── */
  .tools-statusbar { background: var(--surface); border: 1px solid var(--card-border); border-radius: 6px; padding: 7px 14px; font-size: .8rem; margin-bottom: 16px; color: var(--text-muted); }
  .tools-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 16px; }
  @media(max-width:1000px){ .tools-grid{ grid-template-columns: 1fr 1fr; } }
  @media(max-width:640px){ .tools-grid{ grid-template-columns: 1fr; } }
  .tools-panel { background: var(--surface); border: 1px solid var(--card-border); border-radius: var(--radius); overflow: hidden; }
  .tools-panel-header { padding: 11px 16px; font-weight: 700; font-size: .9rem; background: rgba(255,255,255,.03); border-bottom: 1px solid var(--card-border); }
  .tools-panel-body { padding: 14px 16px; }
  .tools-label { font-size: .75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .05em; display: block; margin-bottom: 4px; }
  .tools-hint { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--text-muted); font-size: .72rem; }
  .tools-input {
    background: var(--card-bg); border: 1px solid var(--card-border); color: var(--text);
    padding: 7px 10px; border-radius: 6px; font-size: .85rem; width: 100%;
  }
  .tools-input:focus { outline: 2px solid var(--accent-no-ads); }
  .tools-btn-sm {
    background: var(--card-bg); color: var(--text-muted); border: 1px solid var(--card-border);
    padding: 6px 11px; border-radius: 5px; font-size: .78rem; cursor: pointer; white-space: nowrap;
    transition: background .12s;
  }
  .tools-btn-sm:hover { background: #2a2f4a; color: var(--text); }
  .tools-btn-primary { background: var(--accent-no-ads); color: #fff; border: none; padding: 8px 16px; border-radius: 6px; font-size: .85rem; font-weight: 700; cursor: pointer; transition: opacity .15s; }
  .tools-btn-primary:hover { opacity: .85; }
  .tools-btn-primary:disabled { opacity: .4; cursor: default; }
  .tools-btn-secondary { background: var(--card-bg); color: var(--text-link); border: 1px solid var(--card-border); padding: 8px 14px; border-radius: 6px; font-size: .85rem; font-weight: 600; cursor: pointer; }
  .tools-btn-secondary:hover { background: #2a2f4a; }
  .tools-btn-danger { background: #7f1d1d; color: #fff; border: none; padding: 8px 14px; border-radius: 6px; font-size: .85rem; font-weight: 600; cursor: pointer; }
  .tools-btn-danger:hover { background: #991b1b; }
  .tools-btn-danger:disabled { opacity: .4; cursor: default; }
  .tools-statusrow { font-size: .78rem; color: var(--text-muted); padding: 4px 0; }
  .tools-statusrow.ok { color: var(--accent-no-ads); }
  .tools-statusrow.warn { color: #f5a623; }
  .tools-statusrow.err { color: var(--accent-ads); }
  .radio-opt { font-size: .85rem; display: flex; align-items: center; gap: 5px; cursor: pointer; color: var(--text); }
  .cat-checklist { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; max-height: 200px; overflow-y: auto; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 8px; }
  .cat-checklist label { font-size: .78rem; color: var(--text); display: flex; align-items: center; gap: 5px; cursor: pointer; padding: 2px 0; }
  .tools-log-wrap { background: var(--surface); border: 1px solid var(--card-border); border-radius: var(--radius); padding: 14px 16px; }
  .tools-log { background: #0a0c14; border: 1px solid var(--card-border); border-radius: 6px; padding: 10px 12px; height: 280px; overflow-y: auto; font-family: monospace; font-size: .78rem; line-height: 1.55; }
  .log-ok   { color: #4ade80; }
  .log-err  { color: #f87171; }
  .log-warn { color: #facc15; }
  .log-hdr  { color: #7eb6ff; }
  .log-def  { color: #c8ccd8; }

  /* ── Search / Toolbar ── */
  .toolbar { padding: 16px 24px 0; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .toolbar input {
    background: var(--card-bg); border: 1px solid var(--card-border);
    color: var(--text); padding: 8px 12px; border-radius: 6px; font-size: .88rem;
    flex: 1; max-width: 380px; min-width: 160px;
  }
  .toolbar input:focus { outline: 2px solid var(--accent-no-ads); }
  .btn-export {
    background: #2a2f4a; color: var(--text-link); border: 1px solid var(--card-border);
    padding: 8px 16px; border-radius: 6px; font-size: .88rem; cursor: pointer;
    font-weight: 600; white-space: nowrap; transition: background .15s;
  }
  .btn-export:hover { background: #343b5e; }
  .btn-export:disabled { opacity: .45; cursor: default; }

  /* ── Board ── */
  .board {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    padding: 20px 24px;
    align-items: start;
  }
  @media(max-width:700px){ .board{ grid-template-columns:1fr; } }

  .column {
    background: var(--surface);
    border-radius: var(--radius);
    border: 1px solid var(--card-border);
  }
  .col-header {
    padding: 13px 16px;
    display: flex; align-items: center; gap: 10px;
    border-bottom: 2px solid;
    border-radius: var(--radius) var(--radius) 0 0;
  }
  .col-header.ads    { border-color: var(--accent-ads);    background: rgba(224,74,74,.07); }
  .col-header.no-ads { border-color: var(--accent-no-ads); background: rgba(60,184,120,.07); }
  .col-title { font-weight: 700; font-size: .95rem; flex: 1; }
  .col-count {
    font-size: .75rem; font-weight: 700; padding: 2px 9px;
    border-radius: 20px; background: var(--badge-bg);
  }

  /* ── Cards ── */
  .cards { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 8px;
    padding: 13px 14px;
    transition: border-color .2s;
  }
  .card:hover { border-color: #4a5080; }
  .card-name { font-weight: 700; font-size: .93rem; line-height: 1.35; }
  .card-pkg  { font-size: .71rem; color: var(--text-muted); margin-top: 3px; font-family: monospace; word-break: break-all; }
  .card-meta { margin-top: 9px; display: flex; flex-wrap: wrap; gap: 5px; }
  .badge {
    font-size: .71rem; font-weight: 600; padding: 2px 8px;
    border-radius: 12px; border: 1px solid transparent;
  }
  .badge.category  { background: #1f2a3c; border-color: #5b7fa6; color: #8ab4d4; }
  .badge.apk-scan  { background: #2a1f3c; border-color: #8b6fb5; color: #b89ee0; }
  .sdk-list { margin-top: 7px; font-size: .71rem; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .sdk-list-label { color: var(--text-muted); flex-shrink: 0; }
  .sdk-chip { background: #1e1e30; border: 1px solid #3a3060; color: #a89cc8; padding: 1px 7px; border-radius: 10px; font-size: .68rem; }
  .sdk-chip.trace { border-color: #2d4a2d; background: #1a2a1a; color: #7ab87a; }
  .badge.rating  { background: #2a2f4a; border-color: #f5a623; color: #f5a623; }
  .badge.dl      { background: #2a2f4a; border-color: var(--text-link); color: var(--text-link); }
  .badge.ver     { background: #1e2130; border-color: #3a3f5c; color: var(--text-muted); }
  .badge.ads-yes { background: rgba(224,74,74,.15); border-color: var(--accent-ads); color: var(--accent-ads); }
  .badge.ads-no  { background: rgba(60,184,120,.15); border-color: var(--accent-no-ads); color: var(--accent-no-ads); }
  .badge.unknown { background: #1e2130; border-color: #3a3f5c; color: var(--text-muted); }
  .badge.files   { background: #1e2130; border-color: #3a3f5c; color: var(--text-muted); }
  .store-link {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: .74rem; color: var(--text-link); text-decoration: none; margin-top: 8px;
  }
  .store-link:hover { text-decoration: underline; }
  .not-on-store { font-size: .72rem; color: var(--text-muted); margin-top: 8px; display: block; }
  .empty { text-align: center; padding: 36px 16px; color: var(--text-muted); font-size: .88rem; }

  /* ── Directory browser modal ── */
  .modal-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,.65); z-index: 100;
    align-items: center; justify-content: center;
  }
  .modal-overlay.open { display: flex; }
  .modal {
    background: var(--surface); border: 1px solid var(--card-border);
    border-radius: var(--radius); width: min(560px, 94vw); max-height: 80vh;
    display: flex; flex-direction: column; box-shadow: 0 8px 40px rgba(0,0,0,.6);
  }
  .modal-header {
    padding: 14px 18px; border-bottom: 1px solid var(--card-border);
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
  }
  .modal-header h2 { font-size: 1rem; font-weight: 700; }
  .modal-close {
    background: none; border: none; color: var(--text-muted); font-size: 1.4rem;
    cursor: pointer; line-height: 1; padding: 0 4px;
  }
  .modal-close:hover { color: var(--text); }
  .modal-path {
    padding: 8px 18px; font-size: .78rem; color: var(--text-muted);
    font-family: monospace; background: var(--card-bg);
    border-bottom: 1px solid var(--card-border); word-break: break-all;
  }
  .dir-list { overflow-y: auto; flex: 1; padding: 8px; }
  .dir-item {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-radius: 6px; cursor: pointer;
    font-size: .88rem; transition: background .12s;
  }
  .dir-item:hover { background: var(--card-bg); }
  .dir-item .icon { font-size: 1rem; flex-shrink: 0; }
  .dir-item.up { color: var(--text-muted); border-bottom: 1px solid var(--card-border); margin-bottom: 4px; }
  .modal-footer {
    padding: 12px 18px; border-top: 1px solid var(--card-border);
    display: flex; justify-content: flex-end; gap: 8px;
  }
  .btn-cancel {
    background: var(--card-bg); color: var(--text); border: 1px solid var(--card-border);
    padding: 7px 16px; border-radius: 6px; font-size: .88rem; cursor: pointer;
  }
  .btn-select {
    background: var(--accent-no-ads); color: #fff; border: none;
    padding: 7px 18px; border-radius: 6px; font-size: .88rem; font-weight: 700; cursor: pointer;
  }
  .btn-select:hover { opacity: .85; }

  /* ── Category groups ── */
  .cat-group { border-bottom: 1px solid var(--card-border); }
  .cat-group:last-child { border-bottom: none; }
  .cat-group-header {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 14px; cursor: pointer;
    background: rgba(255,255,255,.03);
    transition: background .15s;
    user-select: none;
  }
  .cat-group-header:hover { background: rgba(255,255,255,.07); }
  .cat-group-title { flex: 1; font-size: .82rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
  .cat-group-count {
    font-size: .72rem; font-weight: 700; padding: 1px 7px;
    border-radius: 12px; background: var(--badge-bg); color: var(--text);
  }
  .cat-group-chevron { font-size: .78rem; color: var(--text-muted); width: 12px; text-align: center; }
  .cat-group-cards { padding: 8px 12px; display: flex; flex-direction: column; gap: 10px; }

  /* loading dots */
  .loading-dots::after { content: '.'; animation: ldots 1.2s steps(3,end) infinite; }
  @keyframes ldots { 0%{content:'.'} 33%{content:'..'} 66%{content:'...'} }

  /* ── Progress modal ── */
  .progress-modal {
    position: fixed; inset: 0; z-index: 200;
    display: flex; align-items: center; justify-content: center;
  }
  .progress-overlay {
    position: absolute; inset: 0;
    background: rgba(0,0,0,.7); cursor: pointer;
  }
  .progress-window {
    position: relative; z-index: 201;
    background: var(--surface); border: 1px solid var(--card-border);
    border-radius: var(--radius); width: min(500px, 92vw);
    box-shadow: 0 12px 60px rgba(0,0,0,.8);
    display: flex; flex-direction: column;
    max-height: 80vh; overflow-y: auto;
  }
  .progress-header {
    padding: 16px 18px; border-bottom: 1px solid var(--card-border);
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    background: rgba(255,255,255,.02);
  }
  #progressTitle {
    font-weight: 700; font-size: .95rem; color: var(--text);
  }
  .progress-close {
    background: none; border: none; color: var(--text-muted);
    font-size: 1.2rem; cursor: pointer; line-height: 1; padding: 0 4px;
  }
  .progress-close:hover { color: var(--text); }
  .progress-body {
    padding: 16px 18px;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .progress-status {
    font-size: .88rem; color: var(--text-muted); margin-bottom: 10px;
    display: flex; align-items: center; gap: 8px;
  }
  .progress-status::before {
    content: ''; display: inline-block; width: 8px; height: 8px;
    border-radius: 50%; background: #4a9eff; animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; } 50% { opacity: 0.4; }
  }
  .progress-bar-container {
    position: relative; margin-bottom: 10px;
  }
  .progress-bar-bg {
    background: var(--card-bg); border: 1px solid var(--card-border);
    border-radius: 8px; height: 28px; overflow: hidden;
    position: relative;
  }
  .progress-bar-fill {
    height: 100%; background: linear-gradient(90deg, #4a9eff, #5ac8ff);
    border-radius: 7px; transition: width .3s ease;
    display: flex; align-items: center; justify-content: flex-end;
    padding-right: 8px; font-weight: 700; font-size: .75rem;
    color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.5);
  }
  .progress-percent {
    position: absolute; top: 50%; right: 8px; transform: translateY(-50%);
    font-weight: 700; font-size: .8rem; color: var(--text-muted);
    z-index: 1; text-shadow: 0 1px 2px rgba(0,0,0,.3);
  }
  .progress-detail {
    font-size: .82rem; color: var(--text-muted); line-height: 1.5;
  }
  .progress-detail div {
    display: flex; justify-content: space-between; gap: 8px;
  }
  .progress-detail strong { color: var(--text); font-size: .8rem; }
  .progress-log {
    background: var(--card-bg); border: 1px solid var(--card-border);
    border-radius: 6px; padding: 10px; overflow-y: auto;
    font-size: .8rem; font-family: monospace; color: #8ab4d4;
    line-height: 1.6; flex: 1;
  }
  .progress-log-entry {
    margin-bottom: 4px; color: #a0a8b8;
  }
  .progress-log-entry.info { color: #8ab4d4; }
  .progress-log-entry.warn { color: #d4a574; }
  .progress-log-entry.ok { color: #5ec583; }

  /* ── Manifest Viewer ── */
  .manifest-container { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media(max-width:1000px){ .manifest-container{ grid-template-columns: 1fr; } }
  .manifest-section { background: var(--surface); border: 1px solid var(--card-border); border-radius: var(--radius); overflow: hidden; }
  .manifest-section-header { padding: 11px 16px; font-weight: 700; font-size: .9rem; background: rgba(255,255,255,.03); border-bottom: 1px solid var(--card-border); }
  .manifest-section-body { padding: 14px 16px; }
  .manifest-info-row { display: flex; justify-content: space-between; margin-bottom: 10px; }
  .manifest-info-label { font-size: .75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .05em; }
  .manifest-info-value { font-family: monospace; font-size: .85rem; color: var(--text); }
  .manifest-xml-viewer { background: #0a0c14; border: 1px solid var(--card-border); border-radius: 6px; padding: 10px; height: 350px; overflow-y: auto; font-family: monospace; font-size: .75rem; line-height: 1.5; color: #8ab4d4; }
  .manifest-xml-viewer code { color: #a0a8b8; }
  .manifest-xml-viewer .tag { color: #ff7b72; }
  .manifest-xml-viewer .attr { color: #7eb6ff; }
  .manifest-xml-viewer .val { color: #a371f7; }

  .permissions-list { display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto; }
  .permission-item {
    padding: 8px 12px; border-radius: 6px; font-size: .8rem; font-family: monospace;
    display: flex; align-items: center; gap: 8px;
  }
  .permission-item.dangerous {
    background: rgba(224, 74, 74, 0.15); border: 1px solid var(--accent-ads);
    color: #fca5a5;
  }
  .permission-item.normal {
    background: var(--card-bg); border: 1px solid var(--card-border);
    color: var(--text-muted);
  }
  .permission-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .permission-dot.dangerous { background: var(--accent-ads); }
  .permission-dot.normal { background: var(--text-muted); }
  .manifest-apk-browser { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 10px; }
  .manifest-apk-item { padding: 8px 10px; cursor: pointer; border-radius: 4px; font-size: .85rem; transition: background .12s; }
  .manifest-apk-item:hover { background: #2a2f4a; }
  .manifest-apk-item.selected { background: var(--accent-no-ads); color: #fff; }
  .manifest-status { padding: 10px 14px; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; font-size: .8rem; color: var(--text-muted); text-align: center; }
</style>
</head>
<body>

<header>
  <h1>🛡️ MAD<span>Pro</span></h1>
  <div class="dir-row">
    <input id="dirInput" type="text" placeholder="Select or type a directory path…" value="" />
    <button class="btn-browse" onclick="openBrowser()">Browse…</button>
    <button class="btn-scan" id="btnScan" onclick="startScan()">Scan</button>
  </div>
</header>

<div class="status-bar" id="statusBar">
  <span class="status-dot"></span>
  <span id="statusText">Select a directory and click Scan.</span>
</div>

<div class="toolbar">
  <input type="text" id="searchInput" placeholder="Search by app name or package…" oninput="renderBoard()" />
  <button class="btn-export" id="btnExport" onclick="openExport()">⬇ Export PDF</button>
</div>

<!-- ── Tab navigation ── -->
<div class="tab-nav">
  <button class="tab-btn active" id="tabBtnKanban" onclick="switchTab('kanban')">📋 Kanban Board</button>
  <button class="tab-btn" id="tabBtnTools" onclick="switchTab('tools')">🔧 Tools</button>
  <button class="tab-btn" id="tabBtnManifest" onclick="switchTab('manifest')">📄 Manifest Viewer</button>
  <button class="tab-btn" id="tabBtnLogs" onclick="switchTab('logs')">🔍 Log Viewer</button>
  <button class="tab-btn" id="tabBtnFsm" onclick="switchTab('fsm')">🔬 FSM Analyzer</button>
  <button class="tab-btn" id="tabBtnJimple" onclick="switchTab('jimple')">🧩 Jimple</button>
  <button class="tab-btn" id="tabBtnChat" onclick="switchTab('chat')">💬 AI Chat</button>
  <button class="tab-btn" id="tabBtnSettings" onclick="switchTab('settings')" style="margin-left:auto;">⚙ Settings</button>
</div>

<!-- ── Kanban tab content ── -->
<div id="tabKanban">
<div class="board">
  <div class="column">
    <div class="col-header ads">
      <span class="col-title">📢 Has Ads</span>
      <span class="col-count" id="countAds">0</span>
    </div>
    <div class="cards" id="colAds"><div class="empty">No apps yet.</div></div>
  </div>
  <div class="column">
    <div class="col-header no-ads">
      <span class="col-title">✅ No Ads</span>
      <span class="col-count" id="countNoAds">0</span>
    </div>
    <div class="cards" id="colNoAds"><div class="empty">No apps yet.</div></div>
  </div>
</div>

<!-- ── Progress modal ── -->
<div id="progressModal" class="progress-modal" style="display: none;">
  <div class="progress-overlay" onclick="if(event.target === this) closeProgress()"></div>
  <div class="progress-window">
    <div class="progress-header">
      <span id="progressTitle">Processing…</span>
      <button class="progress-close" onclick="closeProgress()">✕</button>
    </div>
    <div class="progress-body">
      <div id="progressStatus" class="progress-status">Initializing…</div>
      <div class="progress-bar-container">
        <div class="progress-bar-bg">
          <div id="progressBar" class="progress-bar-fill" style="width: 0%"></div>
        </div>
        <div id="progressPercent" class="progress-percent">0%</div>
      </div>
      <div id="progressDetail" class="progress-detail">
        <div><strong>Scanning:</strong> <span id="scanCount">0</span> APK(s)</div>
        <div><strong>Enriching:</strong> <span id="enrichCount">0</span> / <span id="enrichTotal">0</span></div>
        <div style="margin-top: 8px; font-size: 0.85rem; color: #888;">
          <div id="progressWarning" style="display: none; color: #d4a574; margin-top: 4px;"></div>
        </div>
      </div>
      <div style="margin-top: 10px; border-top: 1px solid rgba(255,255,255,.1); padding-top: 8px; flex: 1; min-height: 140px; display: flex; flex-direction: column;">
        <div style="font-size: 0.72rem; font-weight: 700; color: var(--text-muted); margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.05em;">Activity Log</div>
        <div id="progressLog" class="progress-log" style="flex: 1; min-height: 120px;"></div>
      </div>
    </div>
  </div>
</div>
</div>

<!-- ── Tools tab content ── -->
<div id="tabTools" style="display:none; padding:20px 24px; display:none;">

  <!-- Tool status bar -->
  <div class="tools-statusbar" id="toolsStatusBar">Checking tools…</div>

  <!-- Three-panel layout -->
  <div class="tools-grid">

    <!-- ── Panel 1: Download APKs ── -->
    <div class="tools-panel">
      <div class="tools-panel-header">⬇ Download APKs</div>
      <div class="tools-panel-body">

        <label class="tools-label">Source</label>
        <div style="display:flex;gap:10px;margin-bottom:10px;">
          <label class="radio-opt"><input type="radio" name="dlBackend" value="apkpure" checked onchange="onBackendChange(this)"> ApkPure <span class="tools-hint">(no auth)</span></label>
          <label class="radio-opt"><input type="radio" name="dlBackend" value="google-play" onchange="onBackendChange(this)"> Google Play <span class="tools-hint">(via Appium, device must be signed in)</span></label>
        </div>
        <div id="dlBackendWarn" class="tools-statusrow err" style="display:none;margin-bottom:8px;"></div>

        <label class="tools-label">Apps per category</label>
        <input type="number" id="dlCount" value="5" min="1" max="50" class="tools-input" style="width:80px;margin-bottom:10px;" />

        <label class="tools-label">Output directory</label>
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <input type="text" id="dlOutputDir" class="tools-input" style="flex:1;" placeholder="~/MADPro_Downloads" />
          <button class="tools-btn-sm" onclick="browseForTools('dlOutputDir')">Browse…</button>
        </div>

        <label class="tools-label">Categories</label>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <button class="tools-btn-sm" onclick="selectAllCats(true)">All</button>
          <button class="tools-btn-sm" onclick="selectAllCats(false)">None</button>
        </div>
        <div class="cat-checklist" id="catChecklist"></div>

        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="tools-btn-primary" id="btnStartDownload" onclick="startDownload()">Start Download</button>
          <button class="tools-btn-danger" id="btnCancelDownload" onclick="cancelCurrentJob('download')" disabled>Cancel</button>
        </div>
      </div>
    </div>

    <!-- ── Panel 2: Log Injection ── -->
    <div class="tools-panel">
      <div class="tools-panel-header">💉 Log Injection</div>
      <div class="tools-panel-body">

        <div class="tools-statusrow" id="injectorStatus">Injector: checking…</div>

        <label class="tools-label" style="margin-top:10px;">APK directory</label>
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <input type="text" id="injectApkDir" class="tools-input" style="flex:1;" placeholder="/path/to/apks" />
          <button class="tools-btn-sm" onclick="browseForTools('injectApkDir')">Browse…</button>
        </div>

        <label class="tools-label">Output directory</label>
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <input type="text" id="injectOutputDir" class="tools-input" style="flex:1;" placeholder="~/MADPro_Output" />
          <button class="tools-btn-sm" onclick="browseForTools('injectOutputDir')">Browse…</button>
        </div>

        <label class="tools-label">Class patterns <span class="tools-hint">(comma-separated, e.g. MainActivity, *Login*)</span></label>
        <input type="text" id="injectPatterns" class="tools-input" style="width:100%;margin-bottom:10px;" placeholder="MainActivity, *Activity, com.example.*" />

        <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;">
          <button class="tools-btn-secondary" onclick="compileInjector()">Compile LogInjector</button>
          <button class="tools-btn-primary" id="btnStartInject" onclick="startInjection()">Inject Selected</button>
          <button class="tools-btn-danger" id="btnCancelInject" onclick="cancelCurrentJob('inject')" disabled>Cancel</button>
        </div>
      </div>
    </div>

    <!-- ── Panel 3: Instrument / ADB ── -->
    <div class="tools-panel">
      <div class="tools-panel-header">📱 Instrument APK</div>
      <div class="tools-panel-body">

        <label class="tools-label">Device</label>
        <div style="display:flex;gap:6px;margin-bottom:4px;">
          <select id="deviceSelect" class="tools-input" style="flex:1;"></select>
          <button class="tools-btn-sm" onclick="refreshDevices()">⟳</button>
        </div>
        <div class="tools-statusrow" id="deviceStatus" style="margin-bottom:10px;">No devices found</div>

        <label class="tools-label">APK directory <span class="tools-hint">(folder containing app subdirs with split APKs)</span></label>
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <input type="text" id="instrumentApkDir" class="tools-input" style="flex:1;" placeholder="/path/to/apk-output-dir" />
          <button class="tools-btn-sm" onclick="browseForTools('instrumentApkDir')">Browse…</button>
        </div>

        <label class="tools-label">Logcat output directory <span class="tools-hint">(one .log file per app)</span></label>
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <input type="text" id="instrumentLogDir" class="tools-input" style="flex:1;" placeholder="~/MADPro_Logcat" />
          <button class="tools-btn-sm" onclick="browseForTools('instrumentLogDir')">Browse…</button>
        </div>

        <div style="display:flex;gap:8px;margin-top:4px;">
          <button class="tools-btn-primary" id="btnStartInstrument" onclick="startInstrumentation()">Install &amp; Launch All</button>
          <button class="tools-btn-danger" id="btnCancelInstrument" onclick="cancelCurrentJob('instrument')" disabled>Cancel</button>
        </div>
      </div>
    </div>

  </div><!-- /tools-grid -->

  <!-- Shared log output -->
  <div class="tools-log-wrap">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <span style="font-weight:700;font-size:.9rem;color:var(--accent-no-ads);">Output Log</span>
      <button class="tools-btn-sm" onclick="clearToolsLog()">Clear</button>
    </div>
    <div class="tools-log" id="toolsLog"></div>
  </div>

</div><!-- /tabTools -->

<!-- ── Manifest Viewer tab content ── -->
<div id="tabManifest" style="display:none; padding:20px 24px;">
  <div class="manifest-container">
    <!-- Left: APK Browser -->
    <div class="manifest-section">
      <div class="manifest-section-header">📁 Select APK</div>
      <div class="manifest-section-body">
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <input type="text" id="manifestDirInput" class="tools-input" style="flex:1;" placeholder="Choose directory…" />
          <button class="tools-btn-sm" onclick="browseForManifest()">Browse…</button>
        </div>
        <div id="manifestApkList" class="manifest-apk-browser" style="max-height:350px;overflow-y:auto;">
          <div class="manifest-status">Select a directory to browse APKs</div>
        </div>
      </div>
    </div>

    <!-- Right: Permissions -->
    <div class="manifest-section">
      <div class="manifest-section-header" id="manifestPermHeader">🔒 Permissions (0)</div>
      <div class="manifest-section-body">
        <div id="manifestPermissions" class="permissions-list">
          <div class="manifest-status">Select an APK to view permissions</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Package Info & Manifest XML -->
  <div style="margin-top:20px;display:grid;grid-template-columns:1fr 1fr;gap:20px;">
    <!-- Package Info -->
    <div class="manifest-section">
      <div class="manifest-section-header">📦 Package Information</div>
      <div class="manifest-section-body">
        <div class="manifest-info-row">
          <span class="manifest-info-label">Package:</span>
          <span class="manifest-info-value" id="manifestPkgName">—</span>
        </div>
        <div class="manifest-info-row">
          <span class="manifest-info-label">Version Name:</span>
          <span class="manifest-info-value" id="manifestVersionName">—</span>
        </div>
        <div class="manifest-info-row">
          <span class="manifest-info-label">Version Code:</span>
          <span class="manifest-info-value" id="manifestVersionCode">—</span>
        </div>
        <div class="manifest-info-row">
          <span class="manifest-info-label">Min SDK:</span>
          <span class="manifest-info-value" id="manifestMinSdk">—</span>
        </div>
        <div class="manifest-info-row">
          <span class="manifest-info-label">Target SDK:</span>
          <span class="manifest-info-value" id="manifestTargetSdk">—</span>
        </div>
      </div>
    </div>

    <!-- Manifest XML -->
    <div class="manifest-section">
      <div class="manifest-section-header">📄 AndroidManifest.xml</div>
      <div class="manifest-section-body" style="height:100%;overflow:hidden;display:flex;flex-direction:column;padding:0;">
        <div id="manifestXmlViewer" class="manifest-xml-viewer"></div>
      </div>
    </div>
  </div>
</div>

<!-- ── Log Viewer tab content ── -->
<div id="tabLogs" style="display:none; padding:20px 24px;">
  <!-- Directory + single-file row -->
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;">
    <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:260px;">
      <input type="text" id="logDirInput" class="tools-input" style="flex:1;" placeholder="~/MADPro_Logcat" />
      <button class="tools-btn-sm" onclick="browseForTools('logDirInput')">Browse…</button>
      <button class="tools-btn-sm" onclick="refreshLogFileList()">Load</button>
    </div>
    <select id="logFileSelect" class="tools-input" style="min-width:220px;max-width:340px;" onchange="loadLogFile()">
      <option value="">— select a log file —</option>
    </select>
    <button class="tools-btn-sm" onclick="loadLogFile()">Refresh</button>
    <button class="tools-btn-sm" onclick="clearLogViewer()">Clear</button>
  </div>
  <!-- App package row — populated by scanning all logs in the directory -->
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
    <div style="font-size:.8rem;color:var(--text-muted);white-space:nowrap;">App:</div>
    <select id="logAppSelect" class="tools-input" style="min-width:280px;max-width:520px;" onchange="loadAppLogs()">
      <option value="">— load directory to detect apps —</option>
    </select>
    <div style="font-size:.78rem;color:var(--text-muted);" id="logAppMeta"></div>
  </div>
  <div style="font-size:.8rem;color:var(--text-muted);margin-bottom:8px;" id="logViewerMeta"></div>
  <div id="logViewerOutput" style="
    background:var(--card-bg); border:1px solid var(--card-border); border-radius:8px;
    padding:14px 16px; font-family:monospace; font-size:.78rem; line-height:1.6;
    white-space:pre-wrap; word-break:break-all; max-height:45vh; overflow-y:auto;
    color:var(--text);
  ">Select a log directory above — detected apps will appear in the App dropdown.</div>

  <!-- FSM Model + Keyword Search -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:24px;align-items:start;">

    <!-- Left: keyword search -->
    <div>
      <div style="font-weight:700;font-size:.9rem;color:var(--accent-no-ads);margin-bottom:10px;">Keyword Search</div>
      <div style="font-size:.8rem;color:var(--text-muted);margin-bottom:6px;">Enter keywords (one per line) to check against loaded log entries:</div>
      <textarea id="kwInput" rows="8" style="
        width:100%;box-sizing:border-box;background:var(--card-bg);border:1px solid var(--card-border);
        color:var(--text);padding:10px 12px;border-radius:8px;font-family:monospace;font-size:.82rem;
        line-height:1.6;resize:vertical;
      " placeholder="attachInfo&#10;onCreate&#10;onPause&#10;onResume&#10;onDestroy"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;">
        <button class="tools-btn-primary" onclick="runKeywordSearch()">Search</button>
        <button class="tools-btn-sm" onclick="clearKeywordSearch()">Clear</button>
        <button class="tools-btn-sm" id="genContractBtn" onclick="openFsmContractModal()" style="background:var(--accent-ads);color:#fff;border-color:var(--accent-ads);" title="Generate a Solidity FSM smart contract from logs + keywords and deploy to Ganache">⛓ Generate FSM Contract</button>
        <button class="tools-btn-sm" onclick="openFsmContractModalPush()" style="background:var(--accent-no-ads);color:#fff;border-color:var(--accent-no-ads);" title="Push loaded log data to a deployed FSM smart contract on Ganache">⬆ Push Data to Contract</button>
      </div>
      <div id="kwResults" style="margin-top:14px;"></div>
    </div>

    <!-- Right: FSM model image -->
    <div>
      <div style="font-weight:700;font-size:.9rem;color:var(--accent-no-ads);margin-bottom:10px;">FSM Model</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <input type="text" id="modelImagePath" class="tools-input" style="flex:1;" placeholder="/home/user/model.png" value="/api/model-image" />
        <button class="tools-btn-sm" onclick="loadModelImage()">Load</button>
      </div>
      <div id="modelImageWrap" style="
        background:var(--card-bg);border:1px solid var(--card-border);border-radius:8px;
        padding:8px;overflow:auto;text-align:center;cursor:zoom-in;
      " onclick="toggleModelZoom(this)">
        <img id="modelImage" src="/api/model-image" alt="FSM Model"
          style="max-width:100%;height:auto;border-radius:4px;display:block;margin:0 auto;"
          onerror="this.style.display='none';document.getElementById('modelImageErr').style.display='';" />
        <div id="modelImageErr" style="display:none;color:var(--text-muted);font-size:.82rem;padding:20px;">
          No model image found. Place model.png in the project root or enter a path above.
        </div>
      </div>
      <div style="font-size:.72rem;color:var(--text-muted);margin-top:4px;">Click image to zoom in/out.</div>
    </div>

  </div>
</div><!-- /tabLogs -->

<!-- ── FSM Contract Generator Modal ── -->
<div class="modal-overlay" id="fsmContractModal" onclick="if(event.target===this)closeFsmContractModal()">
  <div class="modal" style="width:min(800px,96vw);max-height:90vh;">
    <div class="modal-header">
      <h2>⛓ Generate FSM Smart Contract</h2>
      <button class="modal-close" onclick="closeFsmContractModal()">×</button>
    </div>
    <div style="padding:16px 18px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:14px;">

      <!-- Step 1: Generate -->
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <button class="tools-btn-primary" id="fsmContractGenBtn" onclick="generateFsmContract()">Generate Contract</button>
        <button class="tools-btn-sm" onclick="loadDefaultFsmContract()" title="Load the built-in FSMViolationAuditor template contract">Load Default</button>
        <span id="fsmContractGenStatus" style="font-size:.8rem;color:var(--text-muted);"></span>
      </div>

      <!-- Contract source -->
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-weight:700;font-size:.85rem;color:var(--accent-no-ads);">Solidity Contract</div>
          <button class="tools-btn-sm" id="fsmContractCopyBtn" onclick="copyFsmContract()" style="display:none;">Copy</button>
        </div>
        <textarea id="fsmContractSource" rows="18" style="
          width:100%;box-sizing:border-box;background:var(--card-bg);border:1px solid var(--card-border);
          color:var(--text);padding:10px 12px;border-radius:8px;font-family:monospace;font-size:.78rem;
          line-height:1.6;resize:vertical;
        " placeholder="Click 'Generate Contract' to create a Solidity FSM smart contract from your log data and keywords…" readonly></textarea>
      </div>

      <!-- Ganache + deploy -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:end;">
        <div>
          <label style="font-size:.8rem;color:var(--text-muted);display:block;margin-bottom:4px;">Ganache URL</label>
          <input type="text" id="ganacheUrl" class="tools-input" value="http://127.0.0.1:7545" style="width:100%;box-sizing:border-box;" />
        </div>
        <div>
          <label style="font-size:.8rem;color:var(--text-muted);display:block;margin-bottom:4px;">Ethereum Account</label>
          <div style="display:flex;gap:6px;">
            <select id="ethAccountSelect" class="tools-input" style="flex:1;">
              <option value="">— load accounts —</option>
            </select>
            <button class="tools-btn-sm" onclick="loadEthAccounts()">Load</button>
          </div>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <button class="tools-btn-primary" id="fsmDeployBtn" onclick="deployFsmContract()" disabled>Deploy to Ganache</button>
        <span id="fsmDeployStatus" style="font-size:.8rem;color:var(--text-muted);"></span>
      </div>

      <!-- Contract address result -->
      <div id="fsmContractResult" style="display:none;background:var(--card-bg);border:1px solid var(--card-border);border-radius:8px;padding:14px 16px;">
        <div style="font-size:.8rem;color:var(--text-muted);margin-bottom:4px;">Deployed Contract Address</div>
        <div style="display:flex;align-items:center;gap:10px;">
          <code id="fsmContractAddress" style="font-size:.9rem;color:var(--accent-no-ads);word-break:break-all;flex:1;"></code>
          <button class="tools-btn-sm" onclick="copyFsmContractAddress()">Copy</button>
        </div>
        <div id="fsmContractTxHash" style="font-size:.72rem;color:var(--text-muted);margin-top:6px;"></div>

      </div>

      <!-- Push data to contract -->
      <div id="fsmPushSection" style="background:var(--card-bg);border:1px solid var(--card-border);border-radius:8px;padding:14px 16px;">
        <div style="font-weight:700;font-size:.85rem;color:var(--accent-no-ads);margin-bottom:10px;">Push Data to Contract</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
          <label style="font-size:.8rem;color:var(--text-muted);white-space:nowrap;">Contract Address</label>
          <input type="text" id="fsmPushContractAddr" class="tools-input" style="flex:1;font-family:monospace;font-size:.8rem;"
            placeholder="0x… (auto-filled after deploy, or paste manually)" />
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button class="tools-btn-primary" id="fsmPushDataBtn" onclick="pushDataToContract()">Push Data to Contract</button>
          <span id="fsmPushStatus" style="font-size:.8rem;color:var(--text-muted);"></span>
        </div>
        <div id="fsmPushProgress" style="display:none;margin-top:10px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <div style="font-size:.78rem;color:var(--text-muted);">Progress:</div>
            <div style="flex:1;background:var(--card-border);border-radius:4px;height:6px;overflow:hidden;">
              <div id="fsmPushBar" style="height:100%;background:var(--accent-no-ads);width:0%;transition:width .2s;border-radius:4px;"></div>
            </div>
            <div id="fsmPushCount" style="font-size:.75rem;color:var(--text-muted);white-space:nowrap;">0 / 0</div>
          </div>
          <div id="fsmPushLog" style="
            font-family:monospace;font-size:.72rem;background:var(--surface);border:1px solid var(--card-border);
            border-radius:6px;padding:8px 10px;max-height:160px;overflow-y:auto;line-height:1.7;
          "></div>
        </div>
      </div>

    </div>
  </div>
</div>

<!-- ── FSM Analyzer tab content ── -->
<div id="tabFsm" style="display:none; padding:20px 24px;">

  <!-- Top bar: log file picker (mirrors Log Viewer) -->
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
    <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:260px;">
      <input type="text" id="fsmLogDirInput" class="tools-input" style="flex:1;" placeholder="~/MADPro_Logcat" />
      <button class="tools-btn-sm" onclick="browseForTools('fsmLogDirInput')">Browse…</button>
      <button class="tools-btn-sm" onclick="fsmRefreshLogList()">Load</button>
    </div>
    <select id="fsmLogFileSelect" class="tools-input" style="min-width:220px;max-width:340px;" onchange="fsmOnFileChange()">
      <option value="">— select a log file —</option>
    </select>
    <button class="tools-btn-sm" onclick="fsmRefreshLogList()">Refresh</button>
  </div>
  <div style="font-size:.8rem;color:var(--text-muted);margin-bottom:12px;" id="fsmLogMeta"></div>

  <!-- Two-column: drop zone left, results right -->
  <div style="display:grid;grid-template-columns:340px 1fr;gap:20px;align-items:start;">

    <!-- Left: FSM image drop zone + controls -->
    <div>
      <div style="font-weight:700;font-size:.85rem;color:var(--accent-no-ads);margin-bottom:8px;">FSM Model Image</div>

      <!-- Drop zone -->
      <div id="fsmDropZone" style="
        border:2px dashed var(--card-border);border-radius:10px;padding:24px 16px;
        text-align:center;cursor:pointer;transition:border-color .15s;min-height:160px;
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
        background:var(--card-bg);
      "
        onclick="document.getElementById('fsmImageInput').click()"
        ondragover="event.preventDefault();this.style.borderColor='var(--accent-no-ads)'"
        ondragleave="this.style.borderColor='var(--card-border)'"
        ondrop="fsmHandleDrop(event)">
        <div id="fsmDropLabel" style="color:var(--text-muted);font-size:.82rem;pointer-events:none;">
          Drop FSM image here<br>or click to browse
        </div>
        <img id="fsmDropPreview" style="max-width:100%;max-height:160px;border-radius:6px;display:none;" />
      </div>
      <input type="file" id="fsmImageInput" accept="image/*" style="display:none;" onchange="fsmHandleFileInput(this)" />

      <button class="tools-btn-primary" id="fsmAnalyzeBtn" style="width:100%;margin-top:10px;" onclick="runFsmAnalysis()" disabled>
        Analyze with AI
      </button>
      <div id="fsmAnalyzeStatus" style="font-size:.78rem;margin-top:6px;min-height:1.2em;color:var(--text-muted);text-align:center;"></div>

      <!-- Extracted keywords -->
      <div id="fsmKeywordsBox" style="display:none;margin-top:14px;">
        <div style="font-weight:700;font-size:.82rem;color:var(--text-muted);margin-bottom:6px;letter-spacing:.04em;">EXTRACTED TRANSITIONS</div>
        <div id="fsmKeywordsList" style="font-size:.78rem;line-height:1.9;"></div>
      </div>
    </div>

    <!-- Right: violations + call sequence -->
    <div>
      <div style="font-weight:700;font-size:.85rem;color:var(--accent-no-ads);margin-bottom:8px;">Analysis Results</div>
      <div id="fsmResultsBox" style="
        background:var(--card-bg);border:1px solid var(--card-border);border-radius:8px;
        padding:16px;min-height:220px;font-size:.8rem;color:var(--text-muted);
      ">Drop an FSM model image and select a log file, then click Analyze.</div>
    </div>

  </div>
</div><!-- /tabFsm -->

<!-- ── Jimple APK browser modal ── -->
<div id="jimpleApkBrowserModal" style="display:none;position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.6);align-items:center;justify-content:center;">
  <div style="background:var(--surface);border:1px solid var(--card-border);border-radius:10px;width:520px;max-height:70vh;display:flex;flex-direction:column;overflow:hidden;">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--card-border);">
      <div style="font-weight:600;font-size:.85rem;">Browse for APK</div>
      <button onclick="document.getElementById('jimpleApkBrowserModal').style.display='none'" style="background:none;border:none;color:var(--text-muted);font-size:1.1rem;cursor:pointer;">✕</button>
    </div>
    <div id="jimpleApkBrowserPath" style="padding:6px 16px;font-size:.72rem;font-family:monospace;color:var(--text-muted);border-bottom:1px solid var(--card-border);"></div>
    <div id="jimpleApkBrowserList" style="flex:1;overflow-y:auto;padding:4px 0;"></div>
  </div>
</div>

<!-- ── Jimple Help modal ── -->
<div id="jimpleHelpModal" onclick="if(event.target===this)this.style.display='none'" style="display:none;position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.65);align-items:center;justify-content:center;">
  <div onclick="event.stopPropagation()" style="background:var(--surface);border:1px solid var(--card-border);border-radius:12px;width:640px;max-height:82vh;display:flex;flex-direction:column;overflow:hidden;">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--card-border);">
      <div style="font-weight:700;font-size:.95rem;">Jimple Decompiler — Help</div>
      <button onclick="document.getElementById('jimpleHelpModal').style.display='none'" style="background:none;border:none;color:var(--text-muted);font-size:1.1rem;cursor:pointer;">✕</button>
    </div>
    <div style="overflow-y:auto;padding:20px;font-size:.8rem;line-height:1.7;color:var(--text);">

      <section style="margin-bottom:18px;">
        <div style="font-weight:600;margin-bottom:6px;">What is Soot &amp; Jimple?</div>
        <p style="color:var(--text-muted);margin:0;">Soot is a Java/Android bytecode analysis framework. This tool uses it to decompile an Android APK into <strong>Jimple</strong> — a simplified, typed, 3-address intermediate representation (IR). Each <code style="background:var(--card-bg);padding:1px 5px;border-radius:4px;">.jimple</code> file corresponds to one Java/Kotlin class from the app. Jimple lets you inspect what an app actually does at the bytecode level without needing its original source code.</p>
      </section>

      <section style="margin-bottom:18px;">
        <div style="font-weight:600;margin-bottom:8px;">Workflow</div>
        <ol style="margin:0;padding-left:1.4em;color:var(--text-muted);">
          <li style="margin-bottom:4px;">Enter the <strong>APK File Path</strong> (use Browse to locate the .apk).</li>
          <li style="margin-bottom:4px;">Set the <strong>Output Directory</strong> where Jimple files will be written.</li>
          <li style="margin-bottom:4px;">Optionally set the <strong>Android Platforms Dir</strong> (e.g. <code style="background:var(--card-bg);padding:1px 4px;border-radius:3px;">~/Android/Sdk/platforms</code>) so Soot can resolve Android framework classes.</li>
          <li style="margin-bottom:4px;">Click <strong>Run Soot</strong> and watch the live output log. Large APKs can take 1–3 minutes.</li>
          <li style="margin-bottom:4px;">Once complete, the output directory is auto-loaded in the <strong>View Jimple File</strong> panel. Select any class to view its decompiled code.</li>
        </ol>
      </section>

      <section style="margin-bottom:18px;">
        <div style="font-weight:600;margin-bottom:8px;">Reading Jimple Code</div>
        <div style="display:grid;gap:8px;">

          <div style="background:var(--card-bg);border-radius:6px;padding:10px;">
            <div style="color:#b794f4;font-weight:600;font-size:.75rem;margin-bottom:3px;">Invoke Types</div>
            <div style="color:var(--text-muted);font-size:.75rem;">How methods are called:</div>
            <div style="margin-top:6px;display:grid;gap:3px;font-size:.73rem;">
              <div><code style="color:#b794f4;">staticinvoke</code> — calls a static method directly on a class (no object needed)</div>
              <div><code style="color:#b794f4;">specialinvoke</code> — calls constructors <code>&lt;init&gt;</code>, super methods, or private methods</div>
              <div><code style="color:#b794f4;">virtualinvoke</code> — calls an instance method with dynamic dispatch (most common)</div>
              <div><code style="color:#b794f4;">interfaceinvoke</code> — calls a method defined in an interface</div>
            </div>
          </div>

          <div style="background:var(--card-bg);border-radius:6px;padding:10px;">
            <div style="color:#63b3ed;font-weight:600;font-size:.75rem;margin-bottom:3px;">Control Flow Keywords</div>
            <div style="margin-top:4px;display:grid;gap:3px;font-size:.73rem;color:var(--text-muted);">
              <div><code style="color:#63b3ed;">if … goto</code> — conditional branch: jumps to a target unit when the expression is true</div>
              <div><code style="color:#63b3ed;">goto</code> — unconditional jump to another statement</div>
              <div><code style="color:#63b3ed;">return</code> — exits the method, optionally carrying a return value</div>
              <div><code style="color:#63b3ed;">throw</code> — raises an exception, transferring to a catch handler</div>
              <div><code style="color:#63b3ed;">switch</code> / <code style="color:#63b3ed;">case</code> — multi-way branch based on a value</div>
              <div><code style="color:#63b3ed;">new</code> — allocates heap memory; constructor called separately via <code>specialinvoke &lt;init&gt;</code></div>
              <div><code style="color:#63b3ed;">instanceof</code> — runtime type check</div>
            </div>
          </div>

          <div style="background:var(--card-bg);border-radius:6px;padding:10px;">
            <div style="color:#76e4f7;font-weight:600;font-size:.75rem;margin-bottom:3px;">Modifiers &amp; Access</div>
            <div style="font-size:.73rem;color:var(--text-muted);"><code style="color:#76e4f7;">public</code> / <code style="color:#76e4f7;">private</code> / <code style="color:#76e4f7;">protected</code> / <code style="color:#76e4f7;">static</code> / <code style="color:#76e4f7;">final</code> / <code style="color:#76e4f7;">abstract</code> — same meaning as in Java source code.</div>
          </div>

          <div style="background:var(--card-bg);border-radius:6px;padding:10px;">
            <div style="color:#9ae6b4;font-weight:600;font-size:.75rem;margin-bottom:3px;">Primitive Types</div>
            <div style="font-size:.73rem;color:var(--text-muted);"><code style="color:#9ae6b4;">void</code> / <code style="color:#9ae6b4;">int</code> / <code style="color:#9ae6b4;">long</code> / <code style="color:#9ae6b4;">boolean</code> / <code style="color:#9ae6b4;">float</code> / <code style="color:#9ae6b4;">double</code> / <code style="color:#9ae6b4;">byte</code> / <code style="color:#9ae6b4;">short</code> / <code style="color:#9ae6b4;">char</code> — the same Java primitive types.</div>
          </div>

          <div style="background:var(--card-bg);border-radius:6px;padding:10px;">
            <div style="color:#68d391;font-weight:600;font-size:.75rem;margin-bottom:3px;">Class References <code style="font-weight:400;">&lt;ClassName: returnType method(params)&gt;</code></div>
            <div style="font-size:.73rem;color:var(--text-muted);">Fully qualified method signatures in Soot format. Example: <code style="color:#68d391;">&lt;android.util.Log: int d(java.lang.String,java.lang.String)&gt;</code> — calling <code>Log.d()</code>.</div>
          </div>

          <div style="background:var(--card-bg);border-radius:6px;padding:10px;">
            <div style="font-weight:600;font-size:.75rem;margin-bottom:3px;">Local Variables</div>
            <div style="font-size:.73rem;color:var(--text-muted);">Jimple auto-names locals using type prefixes: <code>r0</code>, <code>r1</code> (object refs), <code>i0</code>, <code>i1</code> (ints), <code>l0</code> (longs), <code>f0</code> (floats), <code>$stack0</code> (temporaries). These replace original variable names which are lost in compiled bytecode.</div>
          </div>

          <div style="background:var(--card-bg);border-radius:6px;padding:10px;">
            <div style="font-weight:600;font-size:.75rem;margin-bottom:3px;">3-Address Code Format</div>
            <div style="font-size:.73rem;color:var(--text-muted);margin-bottom:4px;">Each Jimple statement performs at most one operation on at most three operands. Complex expressions are broken into simple steps:</div>
            <pre style="margin:0;font-size:.7rem;color:#a8d8a8;background:#0f1117;border-radius:4px;padding:8px;overflow-x:auto;">r0 = new java.lang.StringBuilder;          // allocate
specialinvoke r0.&lt;StringBuilder: void &lt;init&gt;()&gt;();  // construct
r1 = virtualinvoke r0.&lt;StringBuilder: StringBuilder append(String)&gt;("hello");
return r1;</pre>
          </div>

        </div>
      </section>

      <section style="margin-bottom:18px;">
        <div style="font-weight:600;margin-bottom:6px;">What to Look For</div>
        <div style="display:grid;gap:4px;font-size:.75rem;color:var(--text-muted);">
          <div>🔐 <strong>Sensitive API calls</strong> — search for <code>LocationManager</code>, <code>TelephonyManager</code>, <code>Camera</code>, <code>Cipher</code>, <code>Runtime.exec</code></div>
          <div>🌐 <strong>Network endpoints</strong> — look for <code>URL</code>, <code>HttpURLConnection</code>, <code>OkHttpClient</code> invocations and string constants with <code>http://</code></div>
          <div>🔄 <strong>Reflection</strong> — <code>Class.forName</code> and <code>Method.invoke</code> may indicate dynamic code loading or obfuscation</div>
          <div>📦 <strong>Third-party SDKs</strong> — package patterns like <code>com/google/firebase</code>, <code>com/facebook</code>, <code>okhttp3</code></div>
          <div>🔑 <strong>Hardcoded secrets</strong> — string constants (amber) that look like API keys, tokens, or base64 blobs</div>
        </div>
      </section>

      <section>
        <div style="font-weight:600;margin-bottom:6px;">Syntax Highlighting Legend</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:.75rem;">
          <div><span style="color:#b794f4;">■</span> Invoke types (staticinvoke, virtualinvoke…)</div>
          <div><span style="color:#63b3ed;">■</span> Control flow (if, goto, return, throw…)</div>
          <div><span style="color:#76e4f7;">■</span> Modifiers (public, static, final…)</div>
          <div><span style="color:#9ae6b4;">■</span> Primitive types (int, void, boolean…)</div>
          <div><span style="color:#68d391;">■</span> Class references &lt;ClassName: …&gt;</div>
          <div><span style="color:#718096;">■</span> Comments (// …)</div>
          <div><span style="color:#f6ad55;">■</span> String literals</div>
        </div>
      </section>

    </div>
  </div>
</div>

<!-- ── Jimple Decompiler tab content ── -->
<div id="tabJimple" style="display:none; padding:20px 24px;">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <div style="font-weight:700;font-size:1rem;color:var(--accent-no-ads);">🧩 Jimple Decompiler</div>
    <button onclick="document.getElementById('jimpleHelpModal').style.display='flex'" style="padding:5px 12px;border-radius:6px;border:1px solid var(--card-border);background:var(--surface);color:var(--text-muted);font-size:.78rem;cursor:pointer;">❓ Help</button>
  </div>

  <!-- Soot Compiler Panel -->
  <div class="card" style="margin-bottom:16px;">
    <div style="font-weight:600;font-size:.85rem;margin-bottom:12px;">Decompile APK → Jimple</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div>
        <label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:4px;">APK File Path</label>
        <div style="display:flex;gap:6px;">
          <input id="jimpleApkPath" type="text" placeholder="/path/to/app.apk"
            style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.8rem;" />
          <button onclick="jimpleBrowseApk()" style="padding:6px 10px;border-radius:6px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.75rem;cursor:pointer;">Browse</button>
        </div>
      </div>
      <div>
        <label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:4px;">Output Directory</label>
        <div style="display:flex;gap:6px;">
          <input id="jimpleOutputDir" type="text" placeholder="~/sootOutput"
            style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.8rem;" />
          <button onclick="jimpleBrowseOutput()" style="padding:6px 10px;border-radius:6px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.75rem;cursor:pointer;">Browse</button>
        </div>
      </div>
      <div>
        <label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:4px;">Android Platforms Dir <span style="color:var(--text-muted);font-size:.7rem;">(optional)</span></label>
        <input id="jimpleAndroidJars" type="text" placeholder="~/Android/Sdk/platforms"
          style="width:100%;box-sizing:border-box;padding:6px 10px;border-radius:6px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.8rem;" />
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      <button id="jimpleRunBtn" onclick="jimpleRunSoot()" style="padding:7px 18px;border-radius:6px;background:var(--accent-no-ads);color:#fff;border:none;font-size:.82rem;font-weight:600;cursor:pointer;">▶ Run Soot</button>
      <button id="jimpleCancelBtn" onclick="jimpleCancel()" style="display:none;padding:7px 14px;border-radius:6px;background:#ef4444;color:#fff;border:none;font-size:.82rem;cursor:pointer;">■ Cancel</button>
      <span id="jimpleStatus" style="font-size:.78rem;color:var(--text-muted);"></span>
    </div>
    <!-- Soot output log -->
    <div id="jimpleLogWrap" style="display:none;margin-top:12px;">
      <div style="font-size:.75rem;color:var(--text-muted);margin-bottom:4px;">Output</div>
      <div id="jimpleLog" style="background:#1a1a2e;color:#a8d8a8;font-family:monospace;font-size:.72rem;border-radius:6px;padding:10px;height:180px;overflow-y:auto;white-space:pre-wrap;"></div>
    </div>
    <div id="jimpleDoneMsg" style="display:none;margin-top:8px;padding:8px 12px;border-radius:6px;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);color:#10b981;font-size:.78rem;"></div>
  </div>

  <!-- CFG Visualization Panel (below the output log) -->
  <div id="jimpleCfgPanel" class="card" style="display:none;margin-bottom:16px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <div style="font-weight:600;font-size:.85rem;">📊 Control Flow Graphs</div>
      <div style="display:flex;gap:6px;">
        <button onclick="jimpleCfgOpenChat()" title="Chat with AI about this method" style="padding:4px 10px;border-radius:5px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.75rem;cursor:pointer;">💬 Chat with AI</button>
        <button onclick="jimpleCfgFullscreen()" title="Fullscreen" style="padding:4px 10px;border-radius:5px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.75rem;cursor:pointer;">⛶ Fullscreen</button>
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
      <label style="font-size:.75rem;color:var(--text-muted);white-space:nowrap;">Method:</label>
      <select id="jimpleCfgMethodSelect" onchange="jimpleRenderSelectedCfg()"
        style="flex:1;padding:5px 8px;border-radius:5px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.78rem;"></select>
      <button onclick="jimpleCfgZoomIn()" title="Zoom in" style="padding:4px 8px;border-radius:5px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.75rem;cursor:pointer;">+</button>
      <button onclick="jimpleCfgZoomOut()" title="Zoom out" style="padding:4px 8px;border-radius:5px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.75rem;cursor:pointer;">−</button>
      <button onclick="jimpleCfgReset()" title="Fit to view" style="padding:4px 8px;border-radius:5px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.75rem;cursor:pointer;">⊙</button>
    </div>
    <div id="jimpleCfgStatus" style="font-size:.75rem;color:var(--text-muted);margin-bottom:8px;"></div>
    <!-- SVG canvas with pan/zoom -->
    <div id="jimpleCfgViewport" style="width:100%;height:580px;overflow:hidden;background:#0d1117;border-radius:8px;border:1px solid var(--card-border);position:relative;cursor:grab;">
      <svg id="jimpleCfgSvg" style="position:absolute;top:0;left:0;width:100%;height:100%;" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="cfgArrow" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="#64748b"/>
          </marker>
          <marker id="cfgArrowTrue" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="#10b981"/>
          </marker>
          <marker id="cfgArrowFalse" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="#ef4444"/>
          </marker>
        </defs>
        <g id="jimpleCfgRoot"></g>
      </svg>
    </div>
    <div style="margin-top:8px;display:flex;gap:16px;font-size:.72rem;color:var(--text-muted);align-items:center;">
      <span style="display:inline-flex;align-items:center;gap:4px;"><span style="display:inline-block;width:18px;height:2px;background:#64748b;"></span> Fall-through</span>
      <span style="display:inline-flex;align-items:center;gap:4px;"><span style="display:inline-block;width:18px;height:2px;background:#10b981;"></span> Branch true / goto</span>
      <span style="display:inline-flex;align-items:center;gap:4px;"><span style="display:inline-block;width:18px;height:2px;background:#ef4444;"></span> Branch false</span>
      <span style="display:inline-flex;align-items:center;gap:4px;"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:rgba(16,185,129,0.18);border:1px solid #10b981;"></span> Entry</span>
      <span style="display:inline-flex;align-items:center;gap:4px;"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:rgba(239,68,68,0.15);border:1px solid #ef4444;"></span> Exit</span>
      <span style="margin-left:auto;">Drag to pan · Scroll to zoom</span>
    </div>
  </div>

  <!-- CFG Fullscreen Modal -->
  <div id="jimpleCfgFsModal" style="display:none;position:fixed;inset:0;z-index:9999;background:#0d1117;flex-direction:column;">
    <div style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:#111827;border-bottom:1px solid var(--card-border);flex-shrink:0;">
      <span id="jimpleCfgFsTitle" style="font-size:.82rem;color:var(--text-muted);font-family:monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
      <button onclick="jimpleCfgZoomIn(true)" style="padding:4px 10px;border-radius:5px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.8rem;cursor:pointer;">+</button>
      <button onclick="jimpleCfgZoomOut(true)" style="padding:4px 10px;border-radius:5px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.8rem;cursor:pointer;">−</button>
      <button onclick="jimpleCfgReset(true)" style="padding:4px 10px;border-radius:5px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.8rem;cursor:pointer;">⊙ Fit</button>
      <button onclick="jimpleCfgOpenChat()" style="padding:4px 10px;border-radius:5px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.8rem;cursor:pointer;">💬 Chat with AI</button>
      <button onclick="jimpleCfgCloseFullscreen()" style="padding:4px 12px;border-radius:5px;border:1px solid #ef4444;background:transparent;color:#ef4444;font-size:.8rem;cursor:pointer;">✕ Close</button>
    </div>
    <div id="jimpleCfgFsViewport" style="flex:1;overflow:hidden;position:relative;cursor:grab;">
      <svg id="jimpleCfgFsSvg" style="position:absolute;top:0;left:0;width:100%;height:100%;" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="cfgArrowFs" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="#64748b"/>
          </marker>
          <marker id="cfgArrowTrueFs" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="#10b981"/>
          </marker>
          <marker id="cfgArrowFalseFs" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="#ef4444"/>
          </marker>
        </defs>
        <g id="jimpleCfgFsRoot"></g>
      </svg>
    </div>
  </div>

  <!-- CFG AI Chat Modal -->
  <div id="jimpleCfgChatModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6);align-items:stretch;justify-content:center;">
    <div style="width:100%;max-width:1100px;margin:0 auto;display:flex;flex-direction:column;background:var(--card-bg);border-left:1px solid var(--card-border);border-right:1px solid var(--card-border);">
      <!-- Header bar -->
      <div style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--card-border);flex-shrink:0;">
        <span style="font-size:.82rem;font-weight:600;">💬 Chat with AI about Jimple / CFG</span>
        <span style="flex:1;"></span>
        <button onclick="jimpleCfgChatClear()" style="padding:3px 9px;border-radius:5px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.72rem;cursor:pointer;">Clear Chat</button>
        <button onclick="jimpleCfgCloseChat()" style="padding:3px 9px;border-radius:5px;border:1px solid #ef4444;background:transparent;color:#ef4444;font-size:.72rem;cursor:pointer;">✕ Close</button>
      </div>
      <!-- Body: sidebar + chat -->
      <div style="flex:1;display:flex;min-height:0;overflow:hidden;">

        <!-- Left: selection sidebar -->
        <div style="width:280px;min-width:220px;max-width:320px;display:flex;flex-direction:column;border-right:1px solid var(--card-border);background:var(--surface);flex-shrink:0;">
          <div style="padding:8px 12px;border-bottom:1px solid var(--card-border);flex-shrink:0;">
            <div style="font-size:.72rem;font-weight:600;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;">Context Selection</div>
            <input id="jimpleCfgChatFilter" type="text" placeholder="Filter…" oninput="jimpleCfgChatFilterList()"
              style="width:100%;box-sizing:border-box;padding:4px 8px;border-radius:5px;border:1px solid var(--card-border);background:var(--card-bg);color:var(--text);font-size:.75rem;" />
            <div style="display:flex;gap:6px;margin-top:6px;">
              <button onclick="jimpleCfgChatSelectAll(true)" style="flex:1;padding:3px 0;border-radius:4px;border:1px solid var(--card-border);background:var(--card-bg);color:var(--text);font-size:.68rem;cursor:pointer;">All</button>
              <button onclick="jimpleCfgChatSelectAll(false)" style="flex:1;padding:3px 0;border-radius:4px;border:1px solid var(--card-border);background:var(--card-bg);color:var(--text);font-size:.68rem;cursor:pointer;">None</button>
            </div>
          </div>
          <!-- Tab strip: CFGs | Classes -->
          <div style="display:flex;border-bottom:1px solid var(--card-border);flex-shrink:0;">
            <button id="jimpleCfgChatTabCfg" onclick="jimpleCfgChatSwitchTab('cfg')"
              style="flex:1;padding:5px 0;border:none;border-bottom:2px solid var(--accent-no-ads);background:transparent;color:var(--text);font-size:.72rem;cursor:pointer;font-weight:600;">CFG Methods</button>
            <button id="jimpleCfgChatTabClass" onclick="jimpleCfgChatSwitchTab('class')"
              style="flex:1;padding:5px 0;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--text-muted);font-size:.72rem;cursor:pointer;">Jimple Classes</button>
          </div>
          <!-- CFG method list -->
          <div id="jimpleCfgChatListCfg" style="flex:1;overflow-y:auto;padding:6px 0;"></div>
          <!-- Class list (hidden by default) -->
          <div id="jimpleCfgChatListClass" style="flex:1;overflow-y:auto;padding:6px 0;display:none;"></div>
          <!-- Selection summary -->
          <div id="jimpleCfgChatSelCount" style="padding:6px 12px;font-size:.69rem;color:var(--text-muted);border-top:1px solid var(--card-border);flex-shrink:0;"></div>
        </div>

        <!-- Right: chat panel -->
        <div style="flex:1;display:flex;flex-direction:column;min-width:0;">
          <div id="jimpleCfgChatMessages" style="flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;min-height:0;"></div>
          <div style="display:flex;gap:8px;padding:10px 16px;border-top:1px solid var(--card-border);flex-shrink:0;background:var(--surface);">
            <textarea id="jimpleCfgChatInput" rows="2" placeholder="Ask about the selected methods / classes…" onkeydown="jimpleCfgChatKeydown(event)"
              style="flex:1;resize:none;padding:7px 10px;border-radius:7px;border:1px solid var(--card-border);background:var(--card-bg);color:var(--text);font-size:.82rem;font-family:inherit;line-height:1.45;"></textarea>
            <button id="jimpleCfgChatSendBtn" onclick="jimpleCfgChatSend()" style="padding:8px 16px;border-radius:7px;border:none;background:var(--accent-no-ads);color:#fff;font-size:.82rem;cursor:pointer;white-space:nowrap;">Send</button>
          </div>
        </div>

      </div>
    </div>
  </div>

  <!-- Jimple File Viewer Panel -->
  <div class="card">
    <div style="font-weight:600;font-size:.85rem;margin-bottom:12px;">View Jimple File</div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
      <input id="jimpleViewDir" type="text" placeholder="Enter output directory to list .jimple files"
        style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.8rem;" />
      <button onclick="jimpleListFiles()" style="padding:6px 14px;border-radius:6px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.78rem;cursor:pointer;">Load Files</button>
    </div>
    <div id="jimpleFileList" style="display:none;margin-bottom:10px;">
      <label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:4px;">Select .jimple file:</label>
      <div style="display:flex;gap:6px;">
        <input id="jimpleFileSearch" type="text" placeholder="Filter by class name..."
          oninput="jimpleFilterFiles()"
          style="flex:1;padding:5px 10px;border-radius:6px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.78rem;" />
      </div>
      <div id="jimpleFileItems" style="margin-top:6px;max-height:160px;overflow-y:auto;border:1px solid var(--card-border);border-radius:6px;"></div>
    </div>
    <!-- Code viewer -->
    <div id="jimpleCodeWrap" style="display:none;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span id="jimpleCodeTitle" style="font-size:.78rem;color:var(--text-muted);font-family:monospace;"></span>
        <button onclick="jimpleCopyCode()" style="padding:4px 10px;border-radius:5px;border:1px solid var(--card-border);background:var(--surface);color:var(--text);font-size:.72rem;cursor:pointer;">📋 Copy</button>
      </div>
      <div id="jimpleCodeView" style="background:#1a1a2e;border-radius:6px;padding:12px;height:450px;overflow:auto;font-family:monospace;font-size:.72rem;line-height:1.6;"></div>
    </div>
    <div id="jimpleViewStatus" style="font-size:.78rem;color:var(--text-muted);"></div>
  </div>

</div><!-- /tabJimple -->

<!-- ── Settings tab content ── -->
<div id="tabSettings" style="display:none; padding:20px 24px; max-width:640px;">
  <div style="font-weight:700;font-size:1rem;color:var(--accent-no-ads);margin-bottom:20px;">Settings</div>

  <!-- OpenWebUI section -->
  <div style="background:var(--card-bg);border:1px solid var(--card-border);border-radius:10px;padding:20px;margin-bottom:16px;">
    <div style="font-weight:700;font-size:.88rem;margin-bottom:4px;">OpenWebUI</div>
    <div style="font-size:.78rem;color:var(--text-muted);margin-bottom:16px;">
      Used by the FSM Analyzer to extract transitions from model images via vision AI.
      Point this at your OpenWebUI instance (must have a vision-capable model).
    </div>

    <label style="font-size:.8rem;color:var(--text-muted);display:block;margin-bottom:4px;">Server URL</label>
    <input type="text" id="settingsOwUrl" class="tools-input" style="width:100%;margin-bottom:12px;box-sizing:border-box;"
      placeholder="http://localhost:3000" />

    <label style="font-size:.8rem;color:var(--text-muted);display:block;margin-bottom:4px;">API Key</label>
    <input type="password" id="settingsOwKey" class="tools-input" style="width:100%;margin-bottom:12px;box-sizing:border-box;"
      placeholder="sk-…" autocomplete="off" />

    <label style="font-size:.8rem;color:var(--text-muted);display:block;margin-bottom:4px;">Model</label>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
      <input type="text" id="settingsOwModel" class="tools-input" style="flex:1;"
        placeholder="e.g. llava:latest or gpt-4o" />
      <button class="tools-btn-sm" onclick="settingsFetchModels()">Fetch Models</button>
    </div>
    <select id="settingsOwModelSelect" class="tools-input" style="width:100%;margin-bottom:4px;display:none;" onchange="document.getElementById('settingsOwModel').value=this.value">
    </select>
    <div id="settingsModelsStatus" style="font-size:.72rem;color:var(--text-muted);min-height:1.2em;margin-bottom:12px;"></div>

    <div style="display:flex;gap:8px;align-items:center;">
      <button class="tools-btn-primary" onclick="settingsSave()">Save</button>
      <button class="tools-btn-sm" onclick="settingsTest()">Test Connection</button>
      <span id="settingsSaveStatus" style="font-size:.78rem;color:var(--text-muted);"></span>
    </div>
  </div>
</div><!-- /tabSettings -->

<!-- ── AI Chat tab content ── -->
<div id="tabChat" style="display:none; padding:0; height:calc(100vh - 100px); flex-direction:column;">

  <!-- Top bar: file context selector -->
  <div style="display:flex;align-items:center;gap:8px;padding:10px 20px;background:var(--card-bg);border-bottom:1px solid var(--card-border);flex-shrink:0;flex-wrap:wrap;">
    <span style="font-size:.8rem;color:var(--text-muted);white-space:nowrap;">Context file:</span>
    <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:200px;">
      <input type="text" id="chatFileDir" class="tools-input" style="flex:1;" placeholder="~/MADPro_Logcat" />
      <button class="tools-btn-sm" onclick="browseForTools('chatFileDir')">Browse…</button>
      <button class="tools-btn-sm" onclick="chatLoadFileList()">Load</button>
    </div>
    <select id="chatFileSelect" class="tools-input" style="min-width:200px;max-width:320px;">
      <option value="">— no file context —</option>
    </select>
    <div id="chatFileMeta" style="font-size:.72rem;color:var(--text-muted);white-space:nowrap;"></div>
    <div style="display:flex;align-items:center;gap:6px;margin-left:auto;">
      <span style="font-size:.75rem;color:var(--text-muted);white-space:nowrap;">Model:</span>
      <input type="text" id="chatModelInput" class="tools-input" style="width:180px;font-size:.78rem;" placeholder="from Settings" />
      <button class="tools-btn-sm" onclick="chatSaveModel(this)" title="Save model to Settings">Save</button>
      <button class="tools-btn-sm" onclick="chatClear()">Clear chat</button>
    </div>
  </div>

  <!-- Message history -->
  <!-- Chat body: messages + optional mermaid panel side by side -->
  <div style="flex:1;display:flex;overflow:hidden;min-height:0;">

    <!-- Message history -->
    <div id="chatMessages" style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px;min-height:0;"></div>

    <!-- Mermaid Viewer panel (hidden by default) -->
    <div id="chatMermaidPanel" style="display:none;width:440px;flex-shrink:0;border-left:1px solid var(--card-border);flex-direction:column;background:var(--card-bg);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--card-border);flex-shrink:0;">
        <span style="font-size:.8rem;font-weight:600;color:var(--accent);">Mermaid Viewer</span>
        <div style="display:flex;gap:4px;align-items:center;">
          <button class="tools-btn-sm" onclick="chatMermaidRender()" style="background:var(--accent);color:#fff;">Render</button>
          <button class="tools-btn-sm" onclick="chatMermaidZoom('chatMermaidOutput',-0.2)" title="Zoom out">-</button>
          <span id="chatMermaidZoomLabel" style="font-size:.7rem;color:var(--text-muted);min-width:30px;text-align:center;">100%</span>
          <button class="tools-btn-sm" onclick="chatMermaidZoom('chatMermaidOutput',0.2)" title="Zoom in">+</button>
          <button class="tools-btn-sm" onclick="chatMermaidZoomReset('chatMermaidOutput','chatMermaidZoomLabel')" title="Reset zoom">1:1</button>
          <button class="tools-btn-sm" onclick="chatMermaidClear()">Clear</button>
          <button class="tools-btn-sm" onclick="chatMermaidFullscreen()" title="Fullscreen">[ ]</button>
          <button class="tools-btn-sm" onclick="chatMermaidClose()" title="Close">x</button>
        </div>
      </div>
      <textarea id="chatMermaidInput" spellcheck="false" style="
        flex:0 0 200px;resize:vertical;background:#0d1117;color:#e6edf3;
        border:none;border-bottom:1px solid var(--card-border);
        padding:10px 12px;font-family:monospace;font-size:.78rem;line-height:1.5;
        outline:none;
      " placeholder="Paste Mermaid code here..."></textarea>
      <div id="chatMermaidOutput" style="flex:1;overflow:auto;padding:12px;display:flex;align-items:flex-start;justify-content:center;cursor:grab;"></div>
    </div>

  </div>

  <!-- Mermaid fullscreen overlay -->
  <div id="chatMermaidOverlay" onclick="chatMermaidExitFullscreen(event)" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);backdrop-filter:blur(4px);align-items:center;justify-content:center;">
    <div style="position:relative;background:var(--card-bg);border:1px solid var(--card-border);border-radius:12px;width:92vw;height:88vh;display:flex;flex-direction:column;overflow:hidden;" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--card-border);flex-shrink:0;">
        <span style="font-size:.85rem;font-weight:600;color:var(--accent);">Mermaid Viewer</span>
        <div style="display:flex;gap:4px;align-items:center;">
          <button class="tools-btn-sm" onclick="chatMermaidZoom('chatMermaidOverlayOutput',-0.2)" title="Zoom out">-</button>
          <span id="chatMermaidOverlayZoomLabel" style="font-size:.7rem;color:var(--text-muted);min-width:30px;text-align:center;">100%</span>
          <button class="tools-btn-sm" onclick="chatMermaidZoom('chatMermaidOverlayOutput',0.2)" title="Zoom in">+</button>
          <button class="tools-btn-sm" onclick="chatMermaidZoomReset('chatMermaidOverlayOutput','chatMermaidOverlayZoomLabel')" title="Reset zoom">1:1</button>
          <button class="tools-btn-sm" onclick="chatMermaidExitFullscreen()" style="padding:4px 10px;">Close</button>
        </div>
      </div>
      <div id="chatMermaidOverlayOutput" style="flex:1;overflow:auto;padding:20px;display:flex;align-items:flex-start;justify-content:center;cursor:grab;"></div>
    </div>
  </div>

  <!-- Input bar -->
  <div style="display:flex;gap:8px;padding:12px 20px;background:var(--card-bg);border-top:1px solid var(--card-border);flex-shrink:0;align-items:flex-end;">
    <textarea id="chatInput" rows="2" style="
      flex:1;background:var(--surface);border:1px solid var(--card-border);color:var(--text);
      padding:10px 12px;border-radius:8px;font-size:.85rem;line-height:1.5;resize:none;
      font-family:inherit;
    " placeholder="Ask about the loaded file…" onkeydown="chatInputKeydown(event)"></textarea>
    <button class="tools-btn-sm" onclick="chatMermaidToggle()" title="Open Mermaid Viewer" style="align-self:stretch;padding:10px 12px;">Mermaid</button>
    <button class="tools-btn-primary" id="chatSendBtn" onclick="chatSend()" style="padding:10px 20px;align-self:stretch;">Send</button>
  </div>

</div><!-- /tabChat -->

<!-- Export PDF Modal -->
<div class="modal-overlay" id="exportModal" onclick="handleExportOverlayClick(event)">
  <div class="modal">
    <div class="modal-header">
      <h2>Export to PDF</h2>
      <button class="modal-close" onclick="closeExport()">×</button>
    </div>
    <div style="padding:18px 18px 0;">
      <label style="font-size:.85rem;color:var(--text-muted);display:block;margin-bottom:6px;">Save to folder</label>
      <div style="display:flex;gap:8px;align-items:center;">
        <input id="exportDirInput" type="text" style="flex:1;background:var(--card-bg);border:1px solid var(--card-border);color:var(--text);padding:8px 12px;border-radius:6px;font-size:.88rem;" placeholder="/home/user/Documents" />
        <button class="btn-browse" onclick="openSaveBrowser()">Browse…</button>
      </div>
      <label style="font-size:.85rem;color:var(--text-muted);display:block;margin:14px 0 6px;">File name</label>
      <input id="exportFileName" type="text" style="width:100%;background:var(--card-bg);border:1px solid var(--card-border);color:var(--text);padding:8px 12px;border-radius:6px;font-size:.88rem;" value="apk-dashboard.pdf" />
      <div id="exportStatus" style="margin-top:12px;font-size:.82rem;min-height:1.2em;"></div>
    </div>
    <div class="modal-footer" style="margin-top:14px;">
      <button class="btn-cancel" onclick="closeExport()">Cancel</button>
      <button class="btn-select" id="btnDoExport" onclick="doExport()">Save PDF</button>
    </div>
  </div>
</div>

<!-- Save Location Browser Modal -->
<div class="modal-overlay" id="exportSaveBrowserModal" onclick="if(event.target===this)closeSaveBrowser()">
  <div class="modal">
    <div class="modal-header">
      <h2>Choose Save Location</h2>
      <button class="modal-close" onclick="closeSaveBrowser()">×</button>
    </div>
    <div class="modal-path" id="saveBrowserPath"></div>
    <div class="dir-list" id="saveDirList"></div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeSaveBrowser()">Cancel</button>
      <button class="btn-select" onclick="selectSaveDir()">Save Here</button>
    </div>
  </div>
</div>

<!-- Tools Dir Browser Modal -->
<div class="modal-overlay" id="toolsBrowserModal" onclick="if(event.target===this)this.classList.remove('open')">
  <div class="modal">
    <div class="modal-header"><h2>Select Directory</h2><button class="modal-close" onclick="document.getElementById('toolsBrowserModal').classList.remove('open')">×</button></div>
    <div class="modal-path" id="toolsBrowserPath"></div>
    <div class="dir-list" id="toolsDirList"></div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="document.getElementById('toolsBrowserModal').classList.remove('open')">Cancel</button>
      <button class="btn-select" onclick="selectToolsDir()">Select This Folder</button>
    </div>
  </div>
</div>

<!-- APK File Browser Modal -->
<div class="modal-overlay" id="toolsApkBrowserModal" onclick="if(event.target===this)this.classList.remove('open')">
  <div class="modal">
    <div class="modal-header"><h2>Select APK File</h2><button class="modal-close" onclick="document.getElementById('toolsApkBrowserModal').classList.remove('open')">×</button></div>
    <div class="modal-path" id="apkBrowserPath"></div>
    <div class="dir-list" id="apkDirList"></div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="document.getElementById('toolsApkBrowserModal').classList.remove('open')">Cancel</button>
    </div>
  </div>
</div>

<!-- Directory Browser Modal -->
<div class="modal-overlay" id="browserModal" onclick="handleOverlayClick(event)">
  <div class="modal">
    <div class="modal-header">
      <h2>Browse for Directory</h2>
      <button class="modal-close" onclick="closeBrowser()">×</button>
    </div>
    <div class="modal-path" id="browserPath"></div>
    <div class="dir-list" id="dirList"></div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeBrowser()">Cancel</button>
      <button class="btn-select" onclick="selectDir()">Select This Folder</button>
    </div>
  </div>
</div>

<script>
let allApps = [];
let pollTimer = null;
let currentBrowsePath = '';
let progressLogEntries = [];
let lastProgressState = {};

// ── API ─────────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

// ── Scan ────────────────────────────────────────────────────────────────────

async function startScan() {
  const dir = document.getElementById('dirInput').value.trim();
  if (!dir) {
    alert('Please enter or browse to a directory first.');
    return;
  }
  document.getElementById('btnScan').disabled = true;

  // Reset log and show progress modal immediately
  progressLogEntries = [];
  lastProgressState = {};
  const modal = document.getElementById('progressModal');
  if (modal) {
    modal.style.display = 'flex';
  }

  // Add initial log entry
  addProgressLog('Scan started', 'info');

  try {
    addProgressLog('Sending request to server…', 'info');
    await api('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    addProgressLog('Server accepted request, polling status…', 'info');
    pollStatus();
  } catch (err) {
    addProgressLog('Error: ' + err.message, 'warn');
    document.getElementById('statusText').textContent = 'Error: ' + err.message;
    document.getElementById('statusBar').className = 'status-bar error';
    document.getElementById('btnScan').disabled = false;
    closeProgress();
  }
}

// ── Poll ────────────────────────────────────────────────────────────────────

function pollStatus() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(fetchStatus, 800);
}

async function fetchStatus() {
  try {
    const s = await api('/api/status');
    allApps = s.apps || [];
    renderBoard();
    updateStatusBar(s);
    updateProgress(s);
    if (s.scanning || s.enriching) {
      pollStatus();
    } else {
      document.getElementById('btnScan').disabled = false;
    }
  } catch (err) {
    addProgressLog('Status fetch error: ' + err.message, 'warn');
  }
}

function updateStatusBar(s) {
  const bar = document.getElementById('statusBar');
  const txt = document.getElementById('statusText');
  bar.className = 'status-bar';
  if (s.error) {
    bar.classList.add('error');
    txt.textContent = 'Error: ' + s.error;
    return;
  }
  if (s.scanning) {
    bar.classList.add('scanning');
    txt.textContent = (s.warning || 'Scanning APK files…');
    return;
  }
  if (s.enriching) {
    bar.classList.add('enriching');
    txt.textContent = 'Fetching Play Store data: ' + s.progress.done + ' / ' + s.progress.total + '…';
    return;
  }
  bar.classList.add('done');
  txt.textContent = s.dir
    ? 'Scan complete — ' + allApps.length + ' app(s) found in ' + s.dir + (s.warning ? ' (' + s.warning + ')' : '')
    : 'Select a directory and click Scan.';
}

function addProgressLog(message, type = 'info') {
  const entry = { message, type, time: new Date().toLocaleTimeString() };
  progressLogEntries.push(entry);
  // Keep only last 20 entries
  if (progressLogEntries.length > 20) progressLogEntries.shift();
  updateProgressLogDisplay();
}

function updateProgressLogDisplay() {
  const logEl = document.getElementById('progressLog');
  if (!logEl) return;
  logEl.innerHTML = progressLogEntries
    .map(e => '<div class="progress-log-entry ' + e.type + '">[' + e.time + '] ' + e.message + '</div>')
    .join('');
  // Auto-scroll to bottom
  logEl.scrollTop = logEl.scrollHeight;
}

function updateProgress(s) {
  const modal = document.getElementById('progressModal');
  if (!modal) return;

  const isProcessing = s.scanning || s.enriching;

  // Track state changes and log them
  if (s.scanning && !lastProgressState.scanning) {
    addProgressLog('Scanning directory…', 'info');
  }
  if (!s.scanning && lastProgressState.scanning && s.apps?.length) {
    addProgressLog('Scan complete: ' + s.apps.length + ' APK(s) found', 'ok');
  }
  if (s.enriching && !lastProgressState.enriching) {
    addProgressLog('Enriching data…', 'info');
  }
  if (!s.enriching && lastProgressState.enriching) {
    addProgressLog('Enrichment complete', 'ok');
  }
  if (s.warning && !lastProgressState.warning) {
    addProgressLog(s.warning, 'warn');
  }

  lastProgressState = { scanning: s.scanning, enriching: s.enriching, warning: s.warning };

  // Always ensure modal is visible while we have data (even if processing is done)
  if (modal.style.display === 'none' && (s.apps?.length || isProcessing)) {
    modal.style.display = 'flex';
  }

  // Update title
  let title = 'Processing…';
  if (s.scanning) {
    title = '📦 Scanning APK Files';
  } else if (s.enriching) {
    title = '🔍 Enriching App Data';
  } else if (s.apps?.length) {
    title = '✅ Scan Complete';
  }
  document.getElementById('progressTitle').textContent = title;

  // Update status message
  let statusMsg = 'Initializing…';
  if (s.scanning) {
    statusMsg = 'Scanning for APK files in directory…';
  } else if (s.enriching) {
    statusMsg = 'Fetching Play Store information…';
  } else if (s.apps?.length) {
    statusMsg = 'Scan finished successfully!';
  }
  document.getElementById('progressStatus').textContent = statusMsg;

  // Update counts
  const total = s.progress?.total || 0;
  const done = s.progress?.done || 0;
  document.getElementById('scanCount').textContent = s.apps?.length || 0;
  document.getElementById('enrichCount').textContent = done;
  document.getElementById('enrichTotal').textContent = total;

  // Update progress bar
  let percent = 0;
  if (total > 0) {
    percent = Math.round((done / total) * 100);
  } else if (!isProcessing && s.apps?.length) {
    // If not processing and we have apps, show 100%
    percent = 100;
  }
  const bar = document.getElementById('progressBar');
  const percentEl = document.getElementById('progressPercent');
  bar.style.width = percent + '%';
  percentEl.textContent = percent + '%';

  // Auto-close modal after scan completes (after 3 seconds so user can read it)
  if (!isProcessing && s.apps?.length && percent === 100) {
    setTimeout(() => {
      const modal = document.getElementById('progressModal');
      if (modal) modal.style.display = 'none';
    }, 3000);
  }

  // Show warning if present
  const warningEl = document.getElementById('progressWarning');
  if (s.warning) {
    warningEl.textContent = s.warning;
    warningEl.style.display = 'block';
  } else {
    warningEl.style.display = 'none';
  }
}

function closeProgress() {
  document.getElementById('progressModal').style.display = 'none';
  // Reset log for next scan
  progressLogEntries = [];
  lastProgressState = {};
}

// ── Directory browser ────────────────────────────────────────────────────────

async function openBrowser() {
  const startPath = document.getElementById('dirInput').value.trim() || '';
  await loadBrowserDir(startPath || null);
  document.getElementById('browserModal').classList.add('open');
}

function closeBrowser() {
  document.getElementById('browserModal').classList.remove('open');
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById('browserModal')) closeBrowser();
}

async function loadBrowserDir(dirPath) {
  try {
    const data = await api('/api/browse?dir=' + encodeURIComponent(dirPath || ''));
    currentBrowsePath = data.current;
    renderBrowserList(data);
  } catch (err) {
    document.getElementById('dirList').innerHTML =
      '<div class="empty">Cannot read directory: ' + escHtml(err.message) + '</div>';
  }
}

function renderBrowserList(data) {
  document.getElementById('browserPath').textContent = data.current;
  const list = document.getElementById('dirList');
  list.innerHTML = '';

  function makeItem(iconText, labelText, targetPath, extraClass) {
    const div = document.createElement('div');
    div.className = 'dir-item' + (extraClass ? ' ' + extraClass : '');
    div.dataset.target = targetPath;
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = iconText;
    const label = document.createElement('span');
    label.textContent = labelText;
    div.appendChild(icon);
    div.appendChild(label);
    div.addEventListener('click', () => loadBrowserDir(targetPath));
    return div;
  }

  if (data.parent) {
    list.appendChild(makeItem('⬆', '.. (up one level)', data.parent, 'up'));
  }
  if (data.home && data.home !== data.current) {
    list.appendChild(makeItem('🏠', 'Home', data.home, ''));
  }
  for (const d of data.dirs) {
    list.appendChild(makeItem('📁', d.name, d.path, ''));
  }
  if (!data.parent && data.dirs.length === 0) {
    list.innerHTML = '<div class="empty">No subdirectories found.</div>';
  }
}

function selectDir() {
  if (currentBrowsePath) {
    document.getElementById('dirInput').value = currentBrowsePath;
  }
  closeBrowser();
}

// ── Card rendering ───────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function starStr(r) {
  const full = Math.round(r);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

function buildCard(app) {
  const sd = app.storeData;
  const enriching = !sd;
  const pkg = app.package || app.label || '';
  const name = app.appName || pkg || app.label;
  const ver = app.versionName ? 'v' + app.versionName : '';
  const fileCount = (app.apkFiles && app.apkFiles.length) || 1;

  const rating = sd && sd.rating;
  const downloads = sd && sd.downloads;
  const hasAds = sd && sd.hasAds;
  const category = sd && sd.category;
  const storeUrl = sd && sd.storeUrl;
  const onStore = sd && sd.stillOnStore;
  const adSdks = (sd && sd.adSdks) || [];
  const playTraces = (sd && sd.playStoreTraces) || [];
  const scanMethod = sd && sd.scanMethod;
  const isApkScan = scanMethod === 'apk-scan';

  const badges = [];
  if (category) badges.push('<span class="badge category">🏷 ' + escHtml(category) + '</span>');
  if (rating) badges.push('<span class="badge rating">' + rating.toFixed(1) + ' ' + starStr(rating) + '</span>');
  if (downloads) badges.push('<span class="badge dl">' + escHtml(downloads) + '</span>');
  if (ver) badges.push('<span class="badge ver">' + escHtml(ver) + '</span>');
  if (fileCount > 1) badges.push('<span class="badge files">' + fileCount + ' APKs</span>');
  if (isApkScan) badges.push('<span class="badge apk-scan" title="Not on Play Store — detected via APK inspection">🔍 APK Scan</span>');

  if (enriching) {
    badges.push('<span class="badge unknown">Fetching<span class="loading-dots"></span></span>');
  } else if (hasAds === true) {
    badges.push('<span class="badge ads-yes">Has Ads</span>');
  } else if (hasAds === false) {
    badges.push('<span class="badge ads-no">No Ads</span>');
  } else {
    badges.push('<span class="badge unknown">Ads Unknown</span>');
  }

  // Ad SDKs list (only for APK-scanned apps)
  let sdkList = '';
  if (isApkScan && adSdks.length > 0) {
    sdkList = '<div class="sdk-list">'
      + '<span class="sdk-list-label">Ad SDKs detected:</span> '
      + adSdks.map(s => '<span class="sdk-chip">' + escHtml(s) + '</span>').join('')
      + '</div>';
  }

  // Play Store traces (only for APK-scanned apps)
  let traceList = '';
  if (isApkScan && playTraces.length > 0) {
    traceList = '<div class="sdk-list">'
      + '<span class="sdk-list-label">Play Store traces:</span> '
      + playTraces.map(s => '<span class="sdk-chip trace">' + escHtml(s) + '</span>').join('')
      + '</div>';
  }

  let footer = '';
  if (onStore && storeUrl) {
    footer = '<a class="store-link" href="' + escHtml(storeUrl) + '" target="_blank" rel="noopener">▶ View on Play Store</a>';
  } else if (sd && !onStore) {
    footer = '<span class="not-on-store">Not on Play Store</span>';
  }

  return '<div class="card">'
    + '<div class="card-name">' + escHtml(name) + '</div>'
    + '<div class="card-pkg">' + escHtml(pkg) + '</div>'
    + '<div class="card-meta">' + badges.join('') + '</div>'
    + sdkList
    + traceList
    + footer
    + '</div>';
}

// ── Board render ─────────────────────────────────────────────────────────────

/** Groups an array of apps by category, returning sorted [category, apps[]] pairs. */
function groupByCategory(apps) {
  const map = new Map();
  for (const app of apps) {
    const cat = (app.storeData && app.storeData.category) || 'Uncategorized';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(app);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Renders a column's content with collapsible category group headers. */
function buildColumnHtml(apps, emptyMsg) {
  if (!apps.length) return '<div class="empty">' + emptyMsg + '</div>';
  const groups = groupByCategory(apps);
  return groups.map(([cat, catApps]) => {
    const id = 'grp-' + cat.replace(/[^a-zA-Z0-9]+/g, '-');
    const toggle = 'toggleGroup(&quot;' + id + '&quot;)';
    return '<div class="cat-group">'
      + '<div class="cat-group-header" onclick="' + toggle + '">'
      + '<span class="cat-group-title">' + escHtml(cat) + '</span>'
      + '<span class="cat-group-count">' + catApps.length + '</span>'
      + '<span class="cat-group-chevron" id="chev-' + id + '">&#9662;</span>'
      + '</div>'
      + '<div class="cat-group-cards" id="' + id + '">'
      + catApps.map(buildCard).join('')
      + '</div>'
      + '</div>';
  }).join('');
}

function renderBoard() {
  const q = (document.getElementById('searchInput').value || '').toLowerCase();
  const filtered = q
    ? allApps.filter(a =>
        (a.appName || '').toLowerCase().includes(q) ||
        (a.package || '').toLowerCase().includes(q) ||
        (a.label || '').toLowerCase().includes(q))
    : allApps;

  const withAds  = filtered.filter(a => a.storeData && a.storeData.hasAds === true);
  const noAds    = filtered.filter(a => a.storeData && a.storeData.hasAds === false);
  const pending  = filtered.filter(a => !a.storeData || a.storeData.hasAds == null);

  document.getElementById('countAds').textContent    = withAds.length;
  document.getElementById('countNoAds').textContent  = noAds.length;

  const adsCol   = [...withAds, ...pending];
  const noAdsCol = noAds;

  document.getElementById('colAds').innerHTML   = buildColumnHtml(adsCol,   'No apps here.');
  document.getElementById('colNoAds').innerHTML = buildColumnHtml(noAdsCol, 'No apps here.');
}

function toggleGroup(id) {
  const el   = document.getElementById(id);
  const chev = document.getElementById('chev-' + id);
  if (!el) return;
  const collapsed = el.style.display === 'none';
  el.style.display = collapsed ? '' : 'none';
  if (chev) chev.textContent = collapsed ? '▾' : '▸';
}

// ── Export PDF ───────────────────────────────────────────────────────────────

function openExport() {
  const now = new Date();
  const stamp = now.getFullYear() + '-'
    + String(now.getMonth()+1).padStart(2,'0') + '-'
    + String(now.getDate()).padStart(2,'0');
  document.getElementById('exportFileName').value = 'apk-dashboard-' + stamp + '.pdf';
  document.getElementById('exportDirInput').value = '';
  document.getElementById('exportStatus').textContent = '';
  document.getElementById('exportModal').classList.add('open');
}

function closeExport() {
  document.getElementById('exportModal').classList.remove('open');
  document.getElementById('exportSaveBrowserModal')?.classList.remove('open');
}

function handleExportOverlayClick(e) {
  if (e.target === document.getElementById('exportModal')) closeExport();
}

async function openSaveBrowser() {
  const start = document.getElementById('exportDirInput').value.trim() || '';
  await loadSaveBrowserDir(start || null);
  document.getElementById('exportSaveBrowserModal').classList.add('open');
}

function closeSaveBrowser() {
  document.getElementById('exportSaveBrowserModal').classList.remove('open');
}

let currentSavePath = '';

async function loadSaveBrowserDir(dirPath) {
  try {
    const data = await api('/api/browse?dir=' + encodeURIComponent(dirPath || ''));
    currentSavePath = data.current;
    renderSaveBrowserList(data);
  } catch (err) {
    document.getElementById('saveDirList').innerHTML =
      '<div class="empty">Cannot read: ' + escHtml(err.message) + '</div>';
  }
}

function renderSaveBrowserList(data) {
  document.getElementById('saveBrowserPath').textContent = data.current;
  const list = document.getElementById('saveDirList');
  list.innerHTML = '';

  function makeItem(iconText, labelText, targetPath, extraClass) {
    const div = document.createElement('div');
    div.className = 'dir-item' + (extraClass ? ' ' + extraClass : '');
    const icon = document.createElement('span');
    icon.className = 'icon'; icon.textContent = iconText;
    const label = document.createElement('span');
    label.textContent = labelText;
    div.appendChild(icon); div.appendChild(label);
    div.addEventListener('click', () => loadSaveBrowserDir(targetPath));
    return div;
  }

  if (data.parent) list.appendChild(makeItem('⬆', '.. (up one level)', data.parent, 'up'));
  if (data.home && data.home !== data.current) list.appendChild(makeItem('🏠', 'Home', data.home, ''));
  for (const d of data.dirs) list.appendChild(makeItem('📁', d.name, d.path, ''));
  if (!data.parent && data.dirs.length === 0) {
    list.innerHTML = '<div class="empty">No subdirectories found.</div>';
  }
}

function selectSaveDir() {
  if (currentSavePath) document.getElementById('exportDirInput').value = currentSavePath;
  closeSaveBrowser();
}

async function doExport() {
  const dir = document.getElementById('exportDirInput').value.trim();
  const filename = document.getElementById('exportFileName').value.trim() || 'apk-dashboard.pdf';
  const statusEl = document.getElementById('exportStatus');
  const btn = document.getElementById('btnDoExport');

  if (!dir) { statusEl.textContent = 'Please choose a save folder.'; statusEl.style.color = 'var(--accent-ads)'; return; }

  btn.disabled = true;
  statusEl.style.color = 'var(--text-muted)';
  statusEl.textContent = 'Generating PDF…';

  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, filename }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export failed');
    statusEl.style.color = 'var(--accent-no-ads)';
    statusEl.textContent = 'Saved to: ' + data.path;
  } catch (err) {
    statusEl.style.color = 'var(--accent-ads)';
    statusEl.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

// ── Tab switching ────────────────────────────────────────────────────────────

function switchTab(name) {
  document.getElementById('tabKanban').style.display   = name === 'kanban'   ? '' : 'none';
  document.getElementById('tabTools').style.display    = name === 'tools'    ? '' : 'none';
  document.getElementById('tabManifest').style.display = name === 'manifest' ? '' : 'none';
  document.getElementById('tabLogs').style.display     = name === 'logs'     ? '' : 'none';
  document.getElementById('tabFsm').style.display      = name === 'fsm'      ? '' : 'none';
  document.getElementById('tabJimple').style.display   = name === 'jimple'   ? '' : 'none';
  document.getElementById('tabSettings').style.display = name === 'settings' ? '' : 'none';
  var chatEl = document.getElementById('tabChat');
  chatEl.style.display = name === 'chat' ? 'flex' : 'none';
  document.getElementById('tabBtnKanban').classList.toggle('active', name === 'kanban');
  document.getElementById('tabBtnTools').classList.toggle('active', name === 'tools');
  document.getElementById('tabBtnManifest').classList.toggle('active', name === 'manifest');
  document.getElementById('tabBtnLogs').classList.toggle('active', name === 'logs');
  document.getElementById('tabBtnFsm').classList.toggle('active', name === 'fsm');
  document.getElementById('tabBtnJimple').classList.toggle('active', name === 'jimple');
  document.getElementById('tabBtnChat').classList.toggle('active', name === 'chat');
  document.getElementById('tabBtnSettings').classList.toggle('active', name === 'settings');
  if (name === 'tools')    initToolsTab();
  if (name === 'manifest') initManifestTab();
  if (name === 'logs')     initLogsTab();
  if (name === 'fsm')      fsmInitTab();
  if (name === 'settings') settingsInit();
  if (name === 'chat')     chatInitTab();
}

// ── Tools tab ────────────────────────────────────────────────────────────────

const CATEGORIES_LIST = [
  ['GAME_ACTION','Action'],['GAME_CASUAL','Casual'],['GAME_PUZZLE','Puzzle'],
  ['GAME_ROLE_PLAYING','Role Playing'],['SOCIAL','Social'],['COMMUNICATION','Communication'],
  ['PRODUCTIVITY','Productivity'],['ENTERTAINMENT','Entertainment'],['FINANCE','Finance'],
  ['HEALTH_AND_FITNESS','Health & Fitness'],['EDUCATION','Education'],
  ['MUSIC_AND_AUDIO','Music & Audio'],['NEWS_AND_MAGAZINES','News & Magazines'],
  ['SHOPPING','Shopping'],['TRAVEL_AND_LOCAL','Travel & Local'],['TOOLS','Tools'],
  ['PHOTOGRAPHY','Photography'],['BUSINESS','Business'],['MEDICAL','Medical'],
  ['MAPS_AND_NAVIGATION','Maps & Navigation'],
];

let toolsInited = false;
let currentJobs = { download: null, inject: null, instrument: null };
let toolsBrowseTarget = null;

function initToolsTab() {
  if (toolsInited) return;
  toolsInited = true;

  // Build category checklist
  const list = document.getElementById('catChecklist');
  list.innerHTML = CATEGORIES_LIST.map(([id, name]) =>
    '<label><input type="checkbox" class="cat-cb" value="' + id + '" /> ' + escHtml(name) + '</label>'
  ).join('');

  // Set default dirs (home dir injected by server)
  document.getElementById('dlOutputDir').placeholder   = ${JSON.stringify(os.homedir() + "/MADPro_Downloads")};
  document.getElementById('injectOutputDir').placeholder = ${JSON.stringify(os.homedir() + "/MADPro_Output")};

  refreshToolsStatus();
}

async function refreshToolsStatus() {
  const bar = document.getElementById('toolsStatusBar');
  bar.textContent = 'Checking tools…';
  try {
    const s = await api('/api/tools/status');

    const t = s.tools;
    const parts = [
      t.apkeep  ? '✅ apkeep' : '❌ apkeep (install: cargo install apkeep)',
      t.java    ? '✅ java'   : '❌ java (install JDK)',
      t.adb     ? '✅ adb'    : '❌ adb',
      t.zipalign ? '✅ zipalign' : '❌ zipalign',
      t.apksigner ? '✅ apksigner' : '❌ apksigner',
    ];
    bar.textContent = parts.join('   |   ');

    // Injector status
    const ds = document.getElementById('injectorStatus');
    if (!t.java) {
      ds.textContent = 'Java not found — install JDK'; ds.className = 'tools-statusrow err';
    } else if (!t.jarLibsExist) {
      ds.textContent = 'jar_libs/ missing — run: make copy-assets'; ds.className = 'tools-statusrow err';
    } else if (!t.injectorCompiled) {
      ds.textContent = 'LogInjector not compiled — click Compile LogInjector'; ds.className = 'tools-statusrow warn';
    } else {
      ds.textContent = 'LogInjector ready ✅'; ds.className = 'tools-statusrow ok';
    }

    // Devices
    updateDeviceList(s.devices);
  } catch (e) {
    bar.textContent = 'Could not load tool status: ' + e.message;
  }
}

function updateDeviceList(devices) {
  const sel = document.getElementById('deviceSelect');
  const statusEl = document.getElementById('deviceStatus');
  sel.innerHTML = '';
  if (!devices || !devices.length) {
    sel.innerHTML = '<option value="">No devices connected</option>';
    statusEl.textContent = 'No ADB devices found. Connect a device or start an emulator.';
    statusEl.className = 'tools-statusrow warn';
  } else {
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.serial;
      opt.textContent = d.model + ' (' + d.serial + ') [' + d.type + ']';
      sel.appendChild(opt);
    }
    statusEl.textContent = devices.length + ' device(s) connected';
    statusEl.className = 'tools-statusrow ok';
  }
}

async function refreshDevices() {
  const s = await api('/api/tools/status');
  updateDeviceList(s.devices);
}

function selectAllCats(val) {
  document.querySelectorAll('.cat-cb').forEach(cb => cb.checked = val);
}

// ── Tools log ─────────────────────────────────────────────────────────────────

function appendToolsLog(line) {
  if (typeof line !== 'string') return;
  const el = document.getElementById('toolsLog');
  const div = document.createElement('div');
  const lo = line.toLowerCase();
  let cls = 'log-def';
  if (lo.includes('[ok]') || lo.includes('success') || lo.startsWith('--- ')) cls = 'log-ok';
  else if (lo.includes('[error]') || lo.includes('failed') || lo.includes('error:')) cls = 'log-err';
  else if (lo.includes('[warn]') || lo.includes('warning')) cls = 'log-warn';
  else if (lo.startsWith('---') || lo.startsWith('===')) cls = 'log-hdr';
  div.className = cls;
  div.textContent = line;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function clearToolsLog() {
  document.getElementById('toolsLog').innerHTML = '';
}

function streamJob(jobId, onDone) {
  const es = new EventSource('/api/tools/stream/' + jobId);
  es.onmessage = e => {
    const data = JSON.parse(e.data);
    if (data && data.__done) { es.close(); onDone(data.error); return; }
    appendToolsLog(typeof data === 'string' ? data : JSON.stringify(data));
  };
  es.onerror = () => { es.close(); onDone('Stream error'); };
  return es;
}

// ── Download APKs ─────────────────────────────────────────────────────────────

function onBackendChange(radio) {
  const warn = document.getElementById('dlBackendWarn');
  if (radio.value === 'google-play') {
    warn.textContent = 'Uses Appium to automate the Play Store on your connected device. Device must be signed in to a Google account.';
    warn.style.display = 'block';
    warn.className = 'tools-statusrow warn';
  } else {
    warn.textContent = '';
    warn.style.display = 'none';
  }
}

async function startDownload() {
  const categories = [...document.querySelectorAll('.cat-cb:checked')].map(cb => cb.value);
  if (!categories.length) { appendToolsLog('[WARN] Select at least one category.'); return; }
  const outputDir = document.getElementById('dlOutputDir').value.trim() || (document.getElementById('dlOutputDir').placeholder);
  const count = parseInt(document.getElementById('dlCount').value) || 5;
  const backend = document.querySelector('input[name="dlBackend"]:checked')?.value || 'apkpure';
  const deviceSerial = document.getElementById('deviceSelect')?.value || null;

  if (backend === 'google-play' && !deviceSerial) {
    appendToolsLog('[ERROR] Google Play download requires a connected device. Connect a device or emulator first.');
    return;
  }

  document.getElementById('btnStartDownload').disabled = true;
  document.getElementById('btnCancelDownload').disabled = false;
  appendToolsLog('--- Starting download: ' + categories.length + ' categor(ies), ' + count + ' apps each, backend=' + backend + ' ---');

  const r = await api('/api/tools/download', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ categories, count, outputDir, backend, deviceSerial }) });
  currentJobs.download = r.jobId;
  streamJob(r.jobId, err => {
    document.getElementById('btnStartDownload').disabled = false;
    document.getElementById('btnCancelDownload').disabled = true;
    currentJobs.download = null;
    if (err) appendToolsLog('[ERROR] ' + err);
    else appendToolsLog('--- Download complete ---');
  });
}

// ── Log Injection ──────────────────────────────────────────────────────────────

async function compileInjector() {
  appendToolsLog('--- Compiling LogInjector.java ---');
  const r = await api('/api/tools/compile', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
  streamJob(r.jobId, err => {
    if (err) appendToolsLog('[ERROR] ' + err);
    refreshToolsStatus();
  });
}

async function startInjection() {
  const apkDir = document.getElementById('injectApkDir').value.trim();
  const outputDir = document.getElementById('injectOutputDir').value.trim() || document.getElementById('injectOutputDir').placeholder;
  const patternsRaw = document.getElementById('injectPatterns').value.trim();
  const patterns = patternsRaw ? patternsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  if (!apkDir) { appendToolsLog('[WARN] Enter an APK directory first.'); return; }

  document.getElementById('btnStartInject').disabled = true;
  document.getElementById('btnCancelInject').disabled = false;
  appendToolsLog('--- Starting injection: ' + apkDir + ' ---');

  const r = await api('/api/tools/inject', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ apkDir, patterns, outputDir }) });
  currentJobs.inject = r.jobId;
  streamJob(r.jobId, err => {
    document.getElementById('btnStartInject').disabled = false;
    document.getElementById('btnCancelInject').disabled = true;
    currentJobs.inject = null;
    if (err) appendToolsLog('[ERROR] ' + err);
    else appendToolsLog('--- Injection complete ---');
  });
}

// ── Instrumentation ───────────────────────────────────────────────────────────

async function startInstrumentation() {
  const apkDir = document.getElementById('instrumentApkDir').value.trim();
  const logDir = document.getElementById('instrumentLogDir').value.trim();
  const deviceSerial = document.getElementById('deviceSelect').value || null;
  if (!apkDir) { appendToolsLog('[WARN] Enter an APK directory to install from.'); return; }

  document.getElementById('btnStartInstrument').disabled = true;
  document.getElementById('btnCancelInstrument').disabled = false;
  appendToolsLog('--- Scanning ' + apkDir + ' for APK bundles ---');

  const r = await api('/api/tools/instrument', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ apkDir, logDir: logDir || null, deviceSerial }) });
  currentJobs.instrument = r.jobId;
  streamJob(r.jobId, err => {
    document.getElementById('btnStartInstrument').disabled = false;
    document.getElementById('btnCancelInstrument').disabled = true;
    currentJobs.instrument = null;
    if (err && err !== 'Cancelled') appendToolsLog('[ERROR] ' + err);
  });
}

async function cancelCurrentJob(type) {
  const jobId = currentJobs[type];
  if (!jobId) return;
  await api('/api/tools/cancel', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ jobId }) });
  appendToolsLog('[INFO] Cancellation requested for ' + type + ' job');
}

// ── Manifest Viewer ───────────────────────────────────────────────────────────

let _manifestCurrentApk = null;
let _manifestApkList = [];

function initManifestTab() {
  // Initialize on tab load - nothing to do yet
}

function browseForManifest() {
  toolsBrowseTarget = 'manifestDirInput';
  const current = document.getElementById('manifestDirInput')?.value.trim() || '';
  loadToolsBrowserDir(current || null);
  document.getElementById('toolsBrowserModal').classList.add('open');
}

async function loadManifestApks(dirPath) {
  try {
    const data = await api('/api/browse-apks?dir=' + encodeURIComponent(dirPath));
    const listEl = document.getElementById('manifestApkList');

    if (!data.apks || data.apks.length === 0) {
      listEl.innerHTML = '<div class="manifest-status">No APK files found in this directory</div>';
      _manifestApkList = [];
      return;
    }

    _manifestApkList = data.apks;
    let html = '';
    for (let i = 0; i < data.apks.length; i++) {
      const apk = data.apks[i];
      const escaped = escapeHtml(apk.path).replace(/"/g, '&quot;');
      html += '<div class="manifest-apk-item" data-path="' + escaped + '" onclick="selectManifestApkByIndex(' + i + ')">' + escapeHtml(apk.name) + '</div>';
    }
    listEl.innerHTML = html;
  } catch (e) {
    document.getElementById('manifestApkList').innerHTML = '<div class="manifest-status" style="color:#f87171;">Error loading APKs: ' + escapeHtml(e.message) + '</div>';
  }
}

function selectManifestApkByIndex(index) {
  const apk = _manifestApkList[index];
  if (apk) {
    selectManifestApk(apk.path, index);
  }
}

async function selectManifestApk(apkPath, itemIndex) {
  _manifestCurrentApk = apkPath;

  // Update selected style
  const items = document.querySelectorAll('.manifest-apk-item');
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('selected', i === itemIndex);
  }

  // Load manifest
  try {
    const url = '/api/manifest?file=' + encodeURIComponent(apkPath);
    const response = await fetch(url);
    if (!response.ok) {
      showManifestError('HTTP ' + response.status);
      return;
    }
    const data = await response.json();

    if (data.error) {
      showManifestError(data.error);
      return;
    }

    // Update package info
    document.getElementById('manifestPkgName').textContent = data.packageInfo.package || '—';
    document.getElementById('manifestVersionName').textContent = data.packageInfo.versionName || '—';
    document.getElementById('manifestVersionCode').textContent = data.packageInfo.versionCode || '—';
    document.getElementById('manifestMinSdk').textContent = data.packageInfo.minSdkVersion || '—';
    document.getElementById('manifestTargetSdk').textContent = data.packageInfo.targetSdkVersion || '—';

    // Update manifest XML
    const xmlEl = document.getElementById('manifestXmlViewer');
    if (data.manifestXml) {
      let xml = data.manifestXml.substring(0, 5000);
      if (data.manifestXml.length > 5000) xml += ' [truncated...]';
      xmlEl.textContent = xml;
    } else {
      xmlEl.textContent = 'No manifest available';
    }

    // Update permissions
    displayManifestPermissions(data.permissions || [], data.dangerousPermissions || []);
  } catch (e) {
    console.error('Manifest error:', e);
    showManifestError('Error: ' + (e.message || 'Unknown error'));
  }
}

function displayManifestPermissions(allPerms, dangerousPerms) {
  const permEl = document.getElementById('manifestPermissions');
  const headerEl = document.getElementById('manifestPermHeader');

  if (!allPerms || allPerms.length === 0) {
    permEl.innerHTML = '<div class="manifest-status">No permissions found</div>';
    headerEl.textContent = '🔒 Permissions (0)';
    return;
  }

  headerEl.textContent = '🔒 Permissions (' + allPerms.length + ', ' + dangerousPerms.length + ' dangerous)';

  let html = '';
  const dangerousSet = new Set(dangerousPerms);

  // Dangerous permissions first
  const dangerous = allPerms.filter(p => dangerousSet.has(p));
  if (dangerous.length > 0) {
    html += '<div style="margin-bottom:8px;font-size:.75rem;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:.05em;">Dangerous</div>';
    for (const perm of dangerous) {
      html += '<div class="permission-item dangerous"><span class="permission-dot dangerous"></span>' + escapeHtml(perm) + '</div>';
    }
  }

  // Normal permissions
  const normal = allPerms.filter(p => !dangerousSet.has(p));
  if (normal.length > 0) {
    if (dangerous.length > 0) html += '<div style="margin:8px 0;border-top:1px solid var(--card-border);padding-top:8px;"></div>';
    html += '<div style="margin-bottom:8px;font-size:.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;">Normal</div>';
    for (const perm of normal) {
      html += '<div class="permission-item normal"><span class="permission-dot normal"></span>' + escapeHtml(perm) + '</div>';
    }
  }

  permEl.innerHTML = html;
}

function showManifestError(msg) {
  document.getElementById('manifestPkgName').textContent = '—';
  document.getElementById('manifestVersionName').textContent = '—';
  document.getElementById('manifestVersionCode').textContent = '—';
  document.getElementById('manifestMinSdk').textContent = '—';
  document.getElementById('manifestTargetSdk').textContent = '—';
  document.getElementById('manifestXmlViewer').textContent = 'Error: ' + msg;
  document.getElementById('manifestPermissions').innerHTML = '<div class="manifest-status" style="color:#f87171;">' + escapeHtml(msg) + '</div>';
}

// ── Log Viewer ────────────────────────────────────────────────────────────────

function initLogsTab() {
  const dir = document.getElementById('logDirInput').value.trim();
  if (!dir) {
    document.getElementById('logDirInput').value = (typeof os !== 'undefined' ? '' : '') || '~/MADPro_Logcat';
    refreshLogFileList();
  }
}

async function refreshLogFileList() {
  const dir = document.getElementById('logDirInput').value.trim() || '~/MADPro_Logcat';
  try {
    const data = await api('/api/logs/list?dir=' + encodeURIComponent(dir));
    const sel = document.getElementById('logFileSelect');
    const prev = sel.value;
    sel.innerHTML = '<option value="">— select a log file —</option>';
    for (const f of (data.files || [])) {
      const opt = document.createElement('option');
      opt.value = f.path;
      opt.textContent = f.name;
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    document.getElementById('logViewerMeta').textContent =
      data.files.length ? data.files.length + ' log file(s) in ' + data.dir : 'No .log files found in ' + data.dir;
  } catch (e) {
    document.getElementById('logViewerMeta').textContent = 'Error: ' + e.message;
  }
}

const LOG_PAGE = 300; // rows shown per page in the viewer
let _currentLogFile = '';

async function loadLogFile() {
  const file = document.getElementById('logFileSelect').value;
  if (!file) return;
  _currentLogFile = file;
  _fsmLogEntries = [];
  await _renderLogPage(file, 0);
}

async function _renderLogPage(file, offset) {
  const out = document.getElementById('logViewerOutput');
  if (offset === 0) {
    out.innerHTML = '<span style="color:var(--text-muted)">Loading…</span>';
    document.getElementById('logViewerMeta').textContent = 'Loading…';
  }
  try {
    const data = await api('/api/logs/read?file=' + encodeURIComponent(file) + '&offset=' + offset + '&limit=' + LOG_PAGE);
    if (offset === 0) {
      out.innerHTML = '';
      if (!data.total) {
        out.textContent = '(No SootInjection lines found in this log file)';
        document.getElementById('logViewerMeta').textContent = '0 matches in ' + file;
        return;
      }
    }
    // Remove existing load-more button if present
    const old = document.getElementById('logLoadMore');
    if (old) old.remove();

    for (const e of data.entries) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:3px 0; border-bottom:1px solid rgba(255,255,255,.04); display:flex; gap:12px; align-items:baseline;';
      if (e.className) {
        const cls = document.createElement('span');
        cls.style.cssText = 'color:var(--accent-no-ads); min-width:0; flex-shrink:0; max-width:55%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        cls.textContent = e.className;
        const sep = document.createElement('span');
        sep.style.cssText = 'color:var(--text-muted); flex-shrink:0;';
        sep.textContent = '→';
        const mth = document.createElement('span');
        mth.style.cssText = 'color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;';
        mth.title = e.sig;
        mth.textContent = e.returnType + ' ' + e.methodName + '(' + e.args + ')';
        row.appendChild(cls); row.appendChild(sep); row.appendChild(mth);
      } else {
        row.style.color = 'var(--text-muted)';
        row.textContent = e.sig;
      }
      out.appendChild(row);
    }

    const shown = offset + data.entries.length;
    const unique = data.unique;
    document.getElementById('logViewerMeta').textContent =
      'Showing ' + shown + ' of ' + data.total + ' call(s), ' + unique + ' unique methods — ' + file;

    if (shown < data.total) {
      const btn = document.createElement('button');
      btn.id = 'logLoadMore';
      btn.className = 'tools-btn-sm';
      btn.style.cssText = 'margin:8px auto;display:block;';
      btn.textContent = 'Load more (' + (data.total - shown) + ' remaining)';
      btn.onclick = function() { _renderLogPage(file, shown); };
      out.appendChild(btn);
    }

    if (offset === 0) out.scrollTop = 0;
  } catch (e) {
    out.textContent = 'Error loading file: ' + e.message;
  }
}

function clearLogViewer() {
  document.getElementById('logViewerOutput').textContent = 'Select a log directory above — detected apps will appear in the App dropdown.';
  document.getElementById('logViewerMeta').textContent = '';
  document.getElementById('logFileSelect').innerHTML = '<option value="">— select a log file —</option>';
  document.getElementById('logAppSelect').innerHTML = '<option value="">— load directory to detect apps —</option>';
  document.getElementById('logAppMeta').textContent = '';
  _appScanData = null;
  _appLogEntries = [];
  _fsmLogEntries = [];
  _currentLogFile = '';
  clearKeywordSearch();
}

// ── App-based log loading ─────────────────────────────────────────────────────

// _appScanData: result from /api/logs/scan-dir — { dir, packages: [{name, files:[]}] }
let _appScanData = null;
// _appLogEntries: merged entries for the currently selected app
let _appLogEntries = [];

// Called when the user clicks "Load" on the directory input.
// Scans the directory for .log files and detects app package names via nativeloader lines.
async function refreshLogFileList() {
  const dir = document.getElementById('logDirInput').value.trim() || '~/MADPro_Logcat';
  const appSel = document.getElementById('logAppSelect');
  const appMeta = document.getElementById('logAppMeta');
  appSel.innerHTML = '<option value="">— scanning… —</option>';
  appMeta.textContent = '';
  try {
    // File list for single-file dropdown (existing behaviour)
    const listData = await api('/api/logs/list?dir=' + encodeURIComponent(dir));
    const fileSel = document.getElementById('logFileSelect');
    const prev = fileSel.value;
    fileSel.innerHTML = '<option value="">— select a log file —</option>';
    for (const f of (listData.files || [])) {
      const opt = document.createElement('option');
      opt.value = f.path;
      opt.textContent = f.name;
      fileSel.appendChild(opt);
    }
    if (prev && [...fileSel.options].some(o => o.value === prev)) fileSel.value = prev;

    // App scan
    const scanData = await api('/api/logs/scan-dir?dir=' + encodeURIComponent(dir));
    _appScanData = scanData;
    appSel.innerHTML = '<option value="">— select an app —</option>';
    for (const pkg of (scanData.packages || [])) {
      const opt = document.createElement('option');
      opt.value = pkg.name;
      opt.textContent = pkg.name + ' (' + pkg.files.length + ' file' + (pkg.files.length !== 1 ? 's' : '') + ')';
      appSel.appendChild(opt);
    }
    const pkgCount = (scanData.packages || []).length;
    appMeta.textContent = pkgCount
      ? pkgCount + ' app' + (pkgCount !== 1 ? 's' : '') + ' detected across ' + scanData.totalFiles + ' log file' + (scanData.totalFiles !== 1 ? 's' : '')
      : 'No app packages detected in ' + scanData.totalFiles + ' log file' + (scanData.totalFiles !== 1 ? 's' : '');

    document.getElementById('logViewerMeta').textContent =
      listData.files.length ? listData.files.length + ' log file(s) in ' + listData.dir : 'No .log files found in ' + listData.dir;
  } catch (e) {
    appSel.innerHTML = '<option value="">— error scanning —</option>';
    appMeta.textContent = 'Error: ' + e.message;
    document.getElementById('logViewerMeta').textContent = 'Error: ' + e.message;
  }
}

// Called when the user selects an app from the dropdown.
// Loads all log files associated with that app package and renders the class→method view.
async function loadAppLogs() {
  const pkg = document.getElementById('logAppSelect').value;
  if (!pkg || !_appScanData) return;
  const pkgEntry = (_appScanData.packages || []).find(p => p.name === pkg);
  if (!pkgEntry) return;

  const dir = _appScanData.dir;
  const files = pkgEntry.files.map(f => dir + '/' + f);

  const out = document.getElementById('logViewerOutput');
  const meta = document.getElementById('logViewerMeta');
  out.innerHTML = '<span style="color:var(--text-muted)">Loading ' + files.length + ' log file(s) for ' + pkg + '…</span>';
  meta.textContent = 'Loading…';
  try {
    const data = await api('/api/logs/multi-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    _appLogEntries = data.entries || [];
    _currentLogFile = ''; // app-mode: no single file
    meta.textContent = 'Loaded ' + files.length + ' file(s) for ' + pkg + ' — ' + data.total + ' call(s), ' + data.unique + ' unique';
    renderAppLogEntries();
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
    meta.textContent = '';
  }
}

function renderAppLogEntries() {
  const out = document.getElementById('logViewerOutput');
  const meta = document.getElementById('logViewerMeta');
  out.innerHTML = '';

  // Show only unique entries
  const unique = _appLogEntries.filter(e => !e.duplicate);
  if (!unique.length) {
    out.textContent = '(No SootInjection method entries found for this app)';
    return;
  }

  for (const e of unique) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:3px 0; border-bottom:1px solid rgba(255,255,255,.04); display:flex; gap:12px; align-items:baseline;';
    if (e.className) {
      const cls = document.createElement('span');
      cls.style.cssText = 'color:var(--accent-no-ads); min-width:0; flex-shrink:0; max-width:55%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
      cls.textContent = e.className;
      const sep = document.createElement('span');
      sep.style.cssText = 'color:var(--text-muted); flex-shrink:0;';
      sep.textContent = '→';
      const mth = document.createElement('span');
      mth.style.cssText = 'color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;';
      mth.title = e.sig + (e.sourceFile ? ' [' + e.sourceFile + ']' : '');
      mth.textContent = e.returnType + ' ' + e.methodName + '(' + e.args + ')';
      row.appendChild(cls); row.appendChild(sep); row.appendChild(mth);
    } else {
      row.style.color = 'var(--text-muted)';
      row.textContent = e.sig;
    }
    out.appendChild(row);
  }
}

// ── Browse for tools fields ───────────────────────────────────────────────────

function browseForTools(inputId) {
  toolsBrowseTarget = inputId;
  const current = document.getElementById(inputId)?.value.trim() || '';
  loadToolsBrowserDir(current || null);
  document.getElementById('toolsBrowserModal').classList.add('open');
}

function browseForApk() {
  const current = document.getElementById('instrumentApkPath')?.value.trim() || '';
  const lastSlash = current.lastIndexOf('/');
  const startDir = current && lastSlash > 0 ? current.substring(0, lastSlash) : null;
  loadApkBrowserDir(startDir || null);
  document.getElementById('toolsApkBrowserModal').classList.add('open');
}

let currentToolsBrowsePath = '';

async function loadToolsBrowserDir(dirPath) {
  try {
    const data = await api('/api/browse?dir=' + encodeURIComponent(dirPath || ''));
    currentToolsBrowsePath = data.current;
    renderToolsBrowserList(data, 'toolsDirList', 'toolsBrowserPath', loadToolsBrowserDir);
  } catch {}
}

function renderToolsBrowserList(data, listId, pathId, navigateFn) {
  document.getElementById(pathId).textContent = data.current;
  const list = document.getElementById(listId);
  list.innerHTML = '';
  function makeItem(icon, label, target, cls) {
    const d = document.createElement('div');
    d.className = 'dir-item' + (cls ? ' ' + cls : '');
    const ic = document.createElement('span'); ic.className = 'icon'; ic.textContent = icon;
    const lb = document.createElement('span'); lb.textContent = label;
    d.appendChild(ic); d.appendChild(lb);
    d.addEventListener('click', () => navigateFn(target));
    return d;
  }
  if (data.parent) list.appendChild(makeItem('⬆', '.. (up one level)', data.parent, 'up'));
  if (data.home && data.home !== data.current) list.appendChild(makeItem('🏠', 'Home', data.home, ''));
  for (const d of data.dirs) list.appendChild(makeItem('📁', d.name, d.path, ''));
  if (!data.parent && !data.dirs.length) list.innerHTML = '<div class="empty">No subdirectories.</div>';
}

function selectToolsDir() {
  if (toolsBrowseTarget && currentToolsBrowsePath) {
    document.getElementById(toolsBrowseTarget).value = currentToolsBrowsePath;
    // If this is for the manifest viewer, load APKs
    if (toolsBrowseTarget === 'manifestDirInput') {
      loadManifestApks(currentToolsBrowsePath);
    }
  }
  document.getElementById('toolsBrowserModal').classList.remove('open');
}

// APK file browser (shows files too)
let currentApkBrowsePath = '';
async function loadApkBrowserDir(dirPath) {
  try {
    const data = await api('/api/browse-apks?dir=' + encodeURIComponent(dirPath || ''));
    currentApkBrowsePath = data.current;
    document.getElementById('apkBrowserPath').textContent = data.current;
    const list = document.getElementById('apkDirList');
    list.innerHTML = '';
    function makeItem(icon, label, target, cls, isFile) {
      const d = document.createElement('div');
      d.className = 'dir-item' + (cls ? ' ' + cls : '');
      const ic = document.createElement('span'); ic.className = 'icon'; ic.textContent = icon;
      const lb = document.createElement('span'); lb.textContent = label;
      d.appendChild(ic); d.appendChild(lb);
      if (isFile) {
        d.style.color = 'var(--text-link)';
        d.addEventListener('click', () => {
          document.getElementById('instrumentApkPath').value = target;
          document.getElementById('toolsApkBrowserModal').classList.remove('open');
        });
      } else {
        d.addEventListener('click', () => loadApkBrowserDir(target));
      }
      return d;
    }
    if (data.parent) list.appendChild(makeItem('⬆', '.. (up one level)', data.parent, 'up', false));
    if (data.home && data.home !== data.current) list.appendChild(makeItem('🏠', 'Home', data.home, '', false));
    for (const d of data.dirs) list.appendChild(makeItem('📁', d.name, d.path, '', false));
    for (const f of (data.apks || [])) list.appendChild(makeItem('📦', f.name, f.path, '', true));
    if (!data.parent && !data.dirs.length && !(data.apks || []).length) list.innerHTML = '<div class="empty">No items found.</div>';
  } catch {}
}

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const s = await api('/api/status');
    if (s.dir) document.getElementById('dirInput').value = s.dir;
    allApps = s.apps || [];
    renderBoard();
    updateStatusBar(s);
    if (s.scanning || s.enriching) pollStatus();
  } catch {}
})();

// ── Log Keyword Search ────────────────────────────────────────────────────────

let _fsmLogEntries = []; // full entry objects from the currently loaded log
let _kwSequence = [];   // last keyword search call-sequence: [{entry, kwIndices}] in log order

// Strip special chars from a keyword, leaving only alphanumeric + underscore
function cleanKeyword(kw) {
  return kw.replace(/[^a-zA-Z0-9_]/g, '');
}

async function runKeywordSearch() {
  var raw = document.getElementById('kwInput').value;
  var keywords = raw.split('\\n').map(function(k) { return k.trim(); }).filter(function(k) { return k.length > 0; });
  var out = document.getElementById('kwResults');
  if (!keywords.length) { out.innerHTML = ''; return; }
  if (!_currentLogFile) {
    out.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;">Load a log file first.</div>';
    return;
  }

  out.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;">Searching…</div>';

  // Clean keywords: strip special chars, search as method name prefix (methodName + "(")
  var palette = ['#60a5fa','#f472b6','#34d399','#fbbf24','#a78bfa','#f87171','#38bdf8','#fb923c'];
  var kwMeta = keywords.map(function(kw, i) {
    var clean = cleanKeyword(kw);
    return { original: kw, clean: clean, query: clean + '(', color: palette[i % palette.length] };
  });

  // Fetch search results from server for all keywords in one call
  try {
    var queries = kwMeta.map(function(km) { return km.query; });
    var data = await api('/api/logs/search?file=' + encodeURIComponent(_currentLogFile) + '&q=' + encodeURIComponent(JSON.stringify(queries)));

    // data.results: [ { query, matches: [{entry, kwIdx}...] }, ... ]  (in log order)
    // data.perKeyword: [ { query, count }, ... ]

    var hitCount = data.perKeyword.filter(function(pk) { return pk.count > 0; }).length;
    var total = kwMeta.length;
    var summaryColor = hitCount === total ? '#22c55e' : hitCount > 0 ? '#f59e0b' : '#ef4444';
    var summary = hitCount === total ? 'PASS' : hitCount > 0 ? 'PARTIAL' : 'FAIL';

    // ── Summary banner + per-keyword rows ────────────────────────────────
    var summaryRows = '';
    for (var ki = 0; ki < kwMeta.length; ki++) {
      var km = kwMeta[ki];
      var pk = data.perKeyword[ki];
      var found = pk.count > 0;
      if (found) {}
      var icon = found ? '&#x2713;' : '&#x2717;';
      var displayQuery = km.clean ? escHtml(km.clean + '(') : '<em style="color:var(--text-muted)">empty after cleaning</em>';
      summaryRows += '<div style="display:flex;align-items:center;gap:8px;font-size:.82rem;line-height:2;">'
        + '<span style="color:' + km.color + ';font-weight:700;width:14px;">' + icon + '</span>'
        + '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + km.color + ';flex-shrink:0;"></span>'
        + '<span style="font-family:monospace;color:' + km.color + ';">' + displayQuery + '</span>'
        + (km.original !== km.clean + '(' ? '<span style="font-size:.72rem;color:var(--text-muted);">(from: ' + escHtml(km.original) + ')</span>' : '')
        + '<span style="color:var(--text-muted);">' + pk.count + ' match' + (pk.count !== 1 ? 'es' : '') + '</span>'
        + '</div>';
    }

    var html = '<div style="font-size:.88rem;font-weight:700;color:' + summaryColor + ';margin-bottom:10px;padding:8px 12px;background:var(--card-bg);border:1px solid ' + summaryColor + ';border-radius:6px;">'
      + summary + ' &mdash; ' + hitCount + ' / ' + total + ' keywords found</div>'
      + '<div style="margin-bottom:16px;">' + summaryRows + '</div>';

    // Save sequence for Push Data to Contract
    _kwSequence = data.sequence || [];

    // ── Ordered call sequence ─────────────────────────────────────────────
    var seqRows = data.sequence; // [{entry, kwIndices}] in log order
    html += '<div style="font-size:.8rem;font-weight:700;color:var(--text-muted);margin-bottom:6px;letter-spacing:.04em;">CALL SEQUENCE (' + seqRows.length + ' match' + (seqRows.length !== 1 ? 'es' : '') + ', log order)</div>';
    html += '<div style="font-family:monospace;font-size:.75rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:8px;overflow-y:auto;max-height:400px;">';

    if (seqRows.length === 0) {
      html += '<div style="padding:20px;color:var(--text-muted);text-align:center;">No matches found.</div>';
    }
    for (var si = 0; si < seqRows.length; si++) {
      var row = seqRows[si];
      var e = row.entry;
      var hitKws = row.kwIndices.map(function(i) { return kwMeta[i]; });
      var rowColor = hitKws[0].color;

      var entryText = e.className
        ? e.className + ' -> ' + e.returnType + ' ' + e.methodName + '(' + e.args + ')'
        : e.sig;

      // Highlight matched method names in the display
      var highlighted = escHtml(entryText);
      for (var hi = 0; hi < hitKws.length; hi++) {
        var hkw = hitKws[hi];
        if (!hkw.clean) continue;
        var re = new RegExp('(' + escHtml(hkw.clean) + ')', 'gi');
        highlighted = highlighted.replace(re, function(_, m) { return '<mark style="background:' + hkw.color + '33;color:' + hkw.color + ';border-radius:2px;padding:0 1px;font-weight:bold;">' + m + '</mark>'; });
      }

      var badges = hitKws.map(function(km) {
        return '<span style="font-size:.68rem;padding:0 4px;border-radius:3px;background:' + km.color + '22;color:' + km.color + ';border:1px solid ' + km.color + '55;margin-right:3px;">' + escHtml(km.clean || km.original) + '</span>';
      }).join('');

      html += '<div style="display:flex;gap:10px;align-items:baseline;padding:5px 12px;border-bottom:1px solid rgba(255,255,255,.04);border-left:3px solid ' + rowColor + ';">'
        + '<span style="color:var(--text-muted);flex-shrink:0;min-width:28px;text-align:right;font-size:.7rem;">#' + (si + 1) + '</span>'
        + '<div style="min-width:0;flex:1;">'
        + '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + escHtml(entryText) + '">' + highlighted + '</div>'
        + '<div style="margin-top:2px;">' + badges + '</div>'
        + '</div></div>';
    }
    html += '</div>';

    out.innerHTML = html;
  } catch(err) {
    out.innerHTML = '<div style="color:#ef4444;font-size:.82rem;">Search error: ' + escHtml(String(err)) + '</div>';
  }
}

function clearKeywordSearch() {
  document.getElementById('kwInput').value = '';
  document.getElementById('kwResults').innerHTML = '';
  _kwSequence = [];
}

// ── FSM Contract Generator ────────────────────────────────────────────────────

var DEFAULT_FSM_CONTRACT = \`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract FSMViolationAuditor {
    // FSM States as defined in your visualizer
    enum FsmState { START, ADVIEW_SET, LOADED, IMPRESSION, ENGAGEMENT, DISPLAYED }

    struct AppStatus {
        FsmState currentState;
        bool hasViolation;
        string[] methodHistory;
    }

    mapping(string => AppStatus) private appRegistry;
    string[] public appNames;
    mapping(string => bool) private appExists;

    event ViolationDetected(string packageName, string method, string expectedState);

    function recordTransition(string memory _pkg, string memory _method) public {
        if (!appExists[_pkg]) {
            appNames.push(_pkg);
            appExists[_pkg] = true;
            appRegistry[_pkg].currentState = FsmState.START;
        }

        AppStatus storage app = appRegistry[_pkg];
        app.methodHistory.push(_method);

        // Validation Logic
        bool valid = validate(_pkg, _method);

        if (!valid) {
            app.hasViolation = true;
            emit ViolationDetected(_pkg, _method, "Sequence Break");
        }
    }

    function validate(string memory _pkg, string memory _method) internal returns (bool) {
        FsmState current = appRegistry[_pkg].currentState;
        bytes32 m = keccak256(abi.encodePacked(_method));

        // 1. ATTACH INFO -> ADVIEW_SET
        if (m == keccak256("attachInfo")) {
            if (current == FsmState.START || current == FsmState.ADVIEW_SET) {
                appRegistry[_pkg].currentState = FsmState.ADVIEW_SET;
                return true;
            }
        }
        // 2. BUILD -> LOADED
        else if (m == keccak256("build")) {
            if (current == FsmState.ADVIEW_SET || current == FsmState.LOADED) {
                appRegistry[_pkg].currentState = FsmState.LOADED;
                return true;
            }
        }
        // 3. ON AD LOADED -> IMPRESSION
        else if (m == keccak256("onAdLoaded")) {
            if (current == FsmState.LOADED || current == FsmState.IMPRESSION) {
                appRegistry[_pkg].currentState = FsmState.IMPRESSION;
                return true;
            }
        }
        // 4. ON AD CLICKED -> ENGAGEMENT
        else if (m == keccak256("onAdClicked")) {
            if (current == FsmState.IMPRESSION || current == FsmState.ENGAGEMENT) {
                appRegistry[_pkg].currentState = FsmState.ENGAGEMENT;
                return true;
            }
        }
        // 5. SHOW -> DISPLAYED
        else if (m == keccak256("show")) {
            if (current == FsmState.ENGAGEMENT || current == FsmState.DISPLAYED) {
                appRegistry[_pkg].currentState = FsmState.DISPLAYED;
                return true;
            }
        }

        return false; // Any other transition is a violation
    }

    function getViolationStatus(string memory _pkg) public view returns (bool) {
        return appRegistry[_pkg].hasViolation;
    }

    function getAllApps() public view returns (string[] memory) {
        return appNames;
    }

    function getAppMethods(string memory _pkg) public view returns (string[] memory) {
        return appRegistry[_pkg].methodHistory;
    }
}\`;

function loadDefaultFsmContract() {
  var source = document.getElementById('fsmContractSource');
  var copyBtn = document.getElementById('fsmContractCopyBtn');
  var deployBtn = document.getElementById('fsmDeployBtn');
  var status = document.getElementById('fsmContractGenStatus');
  source.value = DEFAULT_FSM_CONTRACT;
  source.removeAttribute('readonly');
  copyBtn.style.display = '';
  deployBtn.disabled = false;
  status.style.color = 'var(--text-muted)';
  status.textContent = 'Default contract loaded.';
}

function openFsmContractModal() {
  document.getElementById('fsmContractModal').classList.add('open');
}

function openFsmContractModalPush() {
  document.getElementById('fsmContractModal').classList.add('open');
  // Scroll the modal body to the push section
  setTimeout(function() {
    var el = document.getElementById('fsmPushSection');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 50);
}

function closeFsmContractModal() {
  document.getElementById('fsmContractModal').classList.remove('open');
}

async function generateFsmContract() {
  var btn = document.getElementById('fsmContractGenBtn');
  var status = document.getElementById('fsmContractGenStatus');
  var source = document.getElementById('fsmContractSource');
  var copyBtn = document.getElementById('fsmContractCopyBtn');
  var deployBtn = document.getElementById('fsmDeployBtn');

  // Collect log summary
  var logFile = _currentLogFile;
  var appEntries = _appLogEntries.length ? _appLogEntries : [];
  var keywords = document.getElementById('kwInput').value
    .split('\\n').map(function(k){ return k.trim(); }).filter(function(k){ return k.length > 0; });

  if (!logFile && !appEntries.length) {
    status.textContent = 'Load a log file first.';
    status.style.color = '#ef4444';
    return;
  }

  btn.disabled = true;
  status.style.color = 'var(--text-muted)';
  status.textContent = 'Generating contract…';
  source.value = '';
  copyBtn.style.display = 'none';
  deployBtn.disabled = true;

  try {
    var body = { keywords: keywords };
    if (logFile) body.logFile = logFile;
    if (appEntries.length) {
      // Send a compact summary: unique method signatures (max 200)
      var unique = appEntries.filter(function(e){ return !e.duplicate; }).slice(0, 200);
      body.logSummary = unique.map(function(e){
        return e.className ? e.className + '#' + e.methodName + '(' + e.args + ')' : e.sig;
      });
    }

    var data = await api('/api/fsm/generate-contract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (data.error) throw new Error(data.error);

    source.value = data.source;
    source.removeAttribute('readonly');
    copyBtn.style.display = '';
    deployBtn.disabled = false;
    status.style.color = '#22c55e';
    status.textContent = 'Contract generated.';
  } catch(err) {
    status.style.color = '#ef4444';
    status.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

function copyFsmContract() {
  var source = document.getElementById('fsmContractSource').value;
  if (!source) return;
  navigator.clipboard.writeText(source).then(function() {
    var btn = document.getElementById('fsmContractCopyBtn');
    var orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(function(){ btn.textContent = orig; }, 1500);
  });
}

async function loadEthAccounts() {
  var url = document.getElementById('ganacheUrl').value.trim() || 'http://127.0.0.1:7545';
  var sel = document.getElementById('ethAccountSelect');
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    var data = await api('/api/eth/accounts?url=' + encodeURIComponent(url));
    if (data.error) throw new Error(data.error);
    sel.innerHTML = '<option value="">— select account —</option>';
    (data.accounts || []).forEach(function(addr) {
      var opt = document.createElement('option');
      opt.value = addr;
      opt.textContent = addr;
      sel.appendChild(opt);
    });
    if (data.accounts && data.accounts.length) sel.value = data.accounts[0];
  } catch(err) {
    sel.innerHTML = '<option value="">Error: ' + escHtml(err.message) + '</option>';
  }
}

async function deployFsmContract() {
  var btn = document.getElementById('fsmDeployBtn');
  var status = document.getElementById('fsmDeployStatus');
  var result = document.getElementById('fsmContractResult');
  var addrEl = document.getElementById('fsmContractAddress');
  var txEl = document.getElementById('fsmContractTxHash');

  var source = document.getElementById('fsmContractSource').value.trim();
  var from = document.getElementById('ethAccountSelect').value.trim();
  var ganacheUrl = document.getElementById('ganacheUrl').value.trim() || 'http://127.0.0.1:7545';

  if (!source) { status.textContent = 'Generate a contract first.'; status.style.color = '#ef4444'; return; }
  if (!from) { status.textContent = 'Select an Ethereum account.'; status.style.color = '#ef4444'; return; }

  btn.disabled = true;
  result.style.display = 'none';
  status.style.color = 'var(--text-muted)';
  status.textContent = 'Compiling & deploying…';

  try {
    var data = await api('/api/eth/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, from, ganacheUrl }),
    });

    if (data.error) throw new Error(data.error);

    addrEl.textContent = data.contractAddress;
    txEl.textContent = 'Tx: ' + data.txHash;
    result.style.display = '';
    // Auto-fill the push section address input
    document.getElementById('fsmPushContractAddr').value = data.contractAddress;
    status.style.color = '#22c55e';
    status.textContent = 'Deployed successfully!';
  } catch(err) {
    status.style.color = '#ef4444';
    status.textContent = 'Deploy failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

function copyFsmContractAddress() {
  var addr = document.getElementById('fsmContractAddress').textContent;
  if (!addr) return;
  navigator.clipboard.writeText(addr).then(function() {
    var btns = document.querySelectorAll('#fsmContractResult button');
    btns.forEach(function(b){ if(b.onclick && b.onclick.toString().includes('copyFsmContractAddress')){
      var orig = b.textContent; b.textContent = 'Copied!';
      setTimeout(function(){ b.textContent = orig; }, 1500);
    }});
  });
}

async function pushDataToContract() {
  var btn = document.getElementById('fsmPushDataBtn');
  var status = document.getElementById('fsmPushStatus');
  var progress = document.getElementById('fsmPushProgress');
  var bar = document.getElementById('fsmPushBar');
  var count = document.getElementById('fsmPushCount');
  var log = document.getElementById('fsmPushLog');

  var contractAddress = document.getElementById('fsmPushContractAddr').value.trim();
  var from = document.getElementById('ethAccountSelect').value.trim();
  var ganacheUrl = document.getElementById('ganacheUrl').value.trim() || 'http://127.0.0.1:7545';

  if (!contractAddress) { status.textContent = 'No contract address — deploy first or paste one.'; status.style.color = '#ef4444'; return; }
  if (!from) { status.textContent = 'Select an Ethereum account first.'; status.style.color = '#ef4444'; return; }

  // Package name: the app selected in the App dropdown (same source as the viewer)
  var pkg = document.getElementById('logAppSelect').value.trim();
  if (!pkg) { status.textContent = 'Select an app from the App dropdown first.'; status.style.color = '#ef4444'; return; }

  // Methods: derived from the keyword search call sequence (filtered output)
  if (!_kwSequence.length) {
    status.textContent = 'Run a Keyword Search first — methods are taken from the call sequence results.';
    status.style.color = '#ef4444';
    return;
  }

  // Build calls: one per sequence row, method = methodName from the entry
  var calls = [];
  for (var i = 0; i < _kwSequence.length; i++) {
    var e = _kwSequence[i].entry;
    if (e && e.methodName) {
      calls.push({ pkg: pkg, method: e.methodName });
    }
  }

  if (!calls.length) {
    status.textContent = 'No method entries in the call sequence.';
    status.style.color = '#ef4444';
    return;
  }

  btn.disabled = true;
  status.style.color = 'var(--text-muted)';
  status.textContent = 'Pushing ' + calls.length + ' call(s)…';
  progress.style.display = '';
  bar.style.width = '0%';
  count.textContent = '0 / ' + calls.length;
  log.innerHTML = '';

  var done = 0, errors = 0;

  function appendLog(text, color) {
    var line = document.createElement('div');
    line.style.color = color || 'var(--text)';
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  // Send in batches of 20 to avoid overwhelming Ganache
  var BATCH = 20;
  for (var i = 0; i < calls.length; i += BATCH) {
    var batch = calls.slice(i, i + BATCH);
    try {
      var result = await api('/api/eth/push-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contractAddress, from, ganacheUrl, calls: batch }),
      });
      for (var j = 0; j < result.results.length; j++) {
        var r = result.results[j];
        done++;
        if (r.error) {
          errors++;
          appendLog('#' + (i + j + 1) + ' ' + r.pkg + ' → ' + r.method + '  ✗ ' + r.error, '#ef4444');
        } else {
          appendLog('#' + (i + j + 1) + ' ' + r.pkg + ' → ' + r.method + '  ✓', '#22c55e');
        }
      }
    } catch(err) {
      errors++;
      appendLog('Batch error: ' + err.message, '#ef4444');
      done += batch.length;
    }
    bar.style.width = Math.round((done / calls.length) * 100) + '%';
    count.textContent = done + ' / ' + calls.length;
  }

  bar.style.width = '100%';
  btn.disabled = false;
  if (errors === 0) {
    status.style.color = '#22c55e';
    status.textContent = 'All ' + calls.length + ' call(s) pushed successfully.';
  } else {
    status.style.color = '#f59e0b';
    status.textContent = done + ' pushed, ' + errors + ' error(s).';
  }
}

function loadModelImage() {
  var path = document.getElementById('modelImagePath').value.trim() || '/api/model-image';
  var img = document.getElementById('modelImage');
  var err = document.getElementById('modelImageErr');
  img.style.display = '';
  err.style.display = 'none';
  img.src = path + '?t=' + Date.now();
}

function toggleModelZoom(wrap) {
  var img = wrap.querySelector('img');
  if (!img) return;
  if (img.style.maxWidth === 'none') {
    img.style.maxWidth = '100%';
    wrap.style.cursor = 'zoom-in';
  } else {
    img.style.maxWidth = 'none';
    wrap.style.cursor = 'zoom-out';
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function settingsInit() {
  try {
    var s = await api('/api/settings');
    document.getElementById('settingsOwUrl').value   = s.openwebui_url   || '';
    document.getElementById('settingsOwModel').value = s.openwebui_model || '';
    // Key is masked server-side — show placeholder if set, blank if not
    var keyInput = document.getElementById('settingsOwKey');
    keyInput.value = '';
    keyInput.placeholder = s.openwebui_key ? 'API key saved (enter new value to change)' : 'sk-…';
  } catch(e) {
    document.getElementById('settingsSaveStatus').textContent = 'Failed to load settings: ' + e.message;
  }
}

async function settingsSave() {
  var statusEl = document.getElementById('settingsSaveStatus');
  statusEl.style.color = 'var(--text-muted)';
  statusEl.textContent = 'Saving…';
  try {
    var payload = {
      openwebui_url:   document.getElementById('settingsOwUrl').value.trim(),
      openwebui_model: document.getElementById('settingsOwModel').value.trim(),
    };
    var keyVal = document.getElementById('settingsOwKey').value.trim();
    if (keyVal) payload.openwebui_key = keyVal;
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    statusEl.style.color = '#22c55e';
    statusEl.textContent = 'Saved.';
    setTimeout(function() { statusEl.textContent = ''; }, 2000);
  } catch(e) {
    statusEl.style.color = '#ef4444';
    statusEl.textContent = 'Error: ' + e.message;
  }
}

async function settingsFetchModels() {
  var statusEl  = document.getElementById('settingsModelsStatus');
  var selectEl  = document.getElementById('settingsOwModelSelect');
  var url = document.getElementById('settingsOwUrl').value.trim();
  var key = document.getElementById('settingsOwKey').value.trim(); // blank = use saved key
  if (!url) { statusEl.textContent = 'Enter a server URL first.'; return; }
  statusEl.textContent = 'Fetching models…';
  selectEl.style.display = 'none';
  try {
    var data = await api('/api/settings/models?url=' + encodeURIComponent(url) + (key ? '&key=' + encodeURIComponent(key) : ''));
    var models = data.models || [];
    if (!models.length) { statusEl.textContent = 'No models returned.'; return; }
    selectEl.innerHTML = '<option value="">— pick a model —</option>';
    for (var i = 0; i < models.length; i++) {
      var opt = document.createElement('option');
      opt.value = models[i].id;
      opt.textContent = models[i].id + (models[i].name && models[i].name !== models[i].id ? '  (' + models[i].name + ')' : '');
      selectEl.appendChild(opt);
    }
    selectEl.style.display = '';
    statusEl.textContent = models.length + ' model(s) found.';
  } catch(e) {
    statusEl.textContent = 'Error: ' + e.message;
  }
}

async function settingsTest() {
  var statusEl = document.getElementById('settingsSaveStatus');
  statusEl.style.color = 'var(--text-muted)';
  statusEl.textContent = 'Testing…';
  var url = document.getElementById('settingsOwUrl').value.trim();
  var key = document.getElementById('settingsOwKey').value.trim();
  if (!url) { statusEl.textContent = 'Enter a server URL first.'; return; }
  try {
    var data = await api('/api/settings/models?url=' + encodeURIComponent(url) + (key ? '&key=' + encodeURIComponent(key) : ''));
    var n = (data.models || []).length;
    statusEl.style.color = '#22c55e';
    statusEl.textContent = 'Connected — ' + n + ' model(s) available.';
  } catch(e) {
    statusEl.style.color = '#ef4444';
    statusEl.textContent = 'Connection failed: ' + e.message;
  }
}

// ── FSM Analyzer ──────────────────────────────────────────────────────────────

var _fsmImageBase64 = '';
var _fsmImageMime   = 'image/png';
var _fsmLogPath     = '';

function fsmInitTab() {
  var dir = document.getElementById('fsmLogDirInput').value.trim();
  if (!dir) {
    document.getElementById('fsmLogDirInput').value = '~/MADPro_Logcat';
    fsmRefreshLogList();
  }
}

async function fsmRefreshLogList() {
  var dir = document.getElementById('fsmLogDirInput').value.trim() || '~/MADPro_Logcat';
  try {
    var data = await api('/api/logs/list?dir=' + encodeURIComponent(dir));
    var sel = document.getElementById('fsmLogFileSelect');
    var prev = sel.value;
    sel.innerHTML = '<option value="">— select a log file —</option>';
    for (var i = 0; i < (data.files || []).length; i++) {
      var f = data.files[i];
      var opt = document.createElement('option');
      opt.value = f.path; opt.textContent = f.name;
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some(function(o) { return o.value === prev; })) sel.value = prev;
    document.getElementById('fsmLogMeta').textContent =
      data.files.length ? data.files.length + ' log file(s) found' : 'No .log files found in ' + data.dir;
  } catch(e) {
    document.getElementById('fsmLogMeta').textContent = 'Error: ' + e.message;
  }
}

function fsmOnFileChange() {
  _fsmLogPath = document.getElementById('fsmLogFileSelect').value;
  fsmCheckReady();
}

function fsmHandleDrop(ev) {
  ev.preventDefault();
  document.getElementById('fsmDropZone').style.borderColor = 'var(--card-border)';
  var file = ev.dataTransfer.files[0];
  if (file) fsmLoadImageFile(file);
}

function fsmHandleFileInput(input) {
  if (input.files[0]) fsmLoadImageFile(input.files[0]);
}

function fsmLoadImageFile(file) {
  _fsmImageMime = file.type || 'image/png';
  var reader = new FileReader();
  reader.onload = function(e) {
    var dataUrl = e.target.result;
    // dataUrl = "data:image/png;base64,XXXX"
    _fsmImageBase64 = dataUrl.split(',')[1];
    var preview = document.getElementById('fsmDropPreview');
    preview.src = dataUrl;
    preview.style.display = '';
    document.getElementById('fsmDropLabel').style.display = 'none';
    fsmCheckReady();
  };
  reader.readAsDataURL(file);
}

function fsmCheckReady() {
  var ready = _fsmImageBase64 && _fsmLogPath;
  document.getElementById('fsmAnalyzeBtn').disabled = !ready;
}

async function runFsmAnalysis() {
  var statusEl = document.getElementById('fsmAnalyzeStatus');
  var resultsEl = document.getElementById('fsmResultsBox');
  var btn = document.getElementById('fsmAnalyzeBtn');
  btn.disabled = true;
  statusEl.textContent = 'Sending image to AI for analysis…';
  resultsEl.innerHTML = '<div style="color:var(--text-muted);">Analyzing…</div>';
  document.getElementById('fsmKeywordsBox').style.display = 'none';

  try {
    var resp = await fetch('/api/fsm/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: _fsmImageBase64,
        imageMime: _fsmImageMime,
        logFile: _fsmLogPath
      })
    });
    if (!resp.ok) {
      var err = await resp.text();
      throw new Error(err);
    }
    var data = await resp.json();
    statusEl.textContent = 'Done.';
    btn.disabled = false;
    fsmRenderResults(data);
  } catch(e) {
    statusEl.textContent = 'Error: ' + e.message;
    resultsEl.innerHTML = '<div style="color:#ef4444;font-size:.82rem;">' + escHtml(String(e)) + '</div>';
    btn.disabled = false;
  }
}

function fsmRenderResults(data) {
  // data: { transitions, keywords, perKeyword, sequence, violations, totalEntries }
  var palette = ['#60a5fa','#f472b6','#34d399','#fbbf24','#a78bfa','#f87171','#38bdf8','#fb923c'];

  // ── Keywords panel ──────────────────────────────────────────────────────
  var kwBox = document.getElementById('fsmKeywordsBox');
  var kwList = document.getElementById('fsmKeywordsList');
  kwList.innerHTML = '';
  for (var i = 0; i < data.transitions.length; i++) {
    var t = data.transitions[i];
    var color = palette[i % palette.length];
    var found = data.perKeyword[i] && data.perKeyword[i].count > 0;
    var icon = found ? '&#x2713;' : '&#x2717;';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:7px;padding:2px 0;';
    row.innerHTML = '<span style="color:' + color + ';font-weight:700;width:12px;">' + icon + '</span>'
      + '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + ';flex-shrink:0;"></span>'
      + '<span style="font-family:monospace;color:' + color + ';flex:1;">' + escHtml(t.method + '(') + '</span>'
      + '<span style="color:var(--text-muted);font-size:.72rem;">'
      + escHtml(t.from) + ' &rarr; ' + escHtml(t.to)
      + '</span>'
      + '<span style="color:var(--text-muted);font-size:.72rem;margin-left:4px;">'
      + (data.perKeyword[i] ? data.perKeyword[i].count + 'x' : '') + '</span>';
    kwList.appendChild(row);
  }
  kwBox.style.display = '';

  // ── Results panel ───────────────────────────────────────────────────────
  var el = document.getElementById('fsmResultsBox');
  var hitKw = data.perKeyword.filter(function(pk) { return pk.count > 0; }).length;
  var totalKw = data.transitions.length;
  var summaryColor = hitKw === totalKw ? '#22c55e' : hitKw > 0 ? '#f59e0b' : '#ef4444';
  var summaryLabel = hitKw === totalKw ? 'PASS' : hitKw > 0 ? 'PARTIAL' : 'FAIL';

  var html = '<div style="font-size:.88rem;font-weight:700;color:' + summaryColor + ';margin-bottom:12px;padding:8px 12px;background:var(--surface);border:1px solid ' + summaryColor + ';border-radius:6px;">'
    + summaryLabel + ' &mdash; ' + hitKw + ' / ' + totalKw + ' transitions observed in log</div>';

  // Violations section
  if (data.violations && data.violations.length > 0) {
    html += '<div style="font-weight:700;font-size:.8rem;color:#ef4444;margin-bottom:6px;letter-spacing:.04em;">VIOLATIONS (' + data.violations.length + ')</div>';
    html += '<div style="margin-bottom:16px;">';
    for (var vi = 0; vi < data.violations.length; vi++) {
      var v = data.violations[vi];
      html += '<div style="padding:6px 10px;background:#7f1d1d22;border:1px solid #ef444444;border-radius:6px;margin-bottom:6px;font-size:.78rem;">'
        + '<span style="color:#ef4444;font-weight:700;">' + escHtml(v.type) + '</span>'
        + '<span style="color:var(--text-muted);"> &mdash; </span>'
        + '<span style="color:var(--text);font-family:monospace;">' + escHtml(v.detail) + '</span>'
        + '</div>';
    }
    html += '</div>';
  } else if (hitKw > 0) {
    html += '<div style="color:#22c55e;font-size:.82rem;margin-bottom:16px;">No sequence violations detected.</div>';
  }

  // Call sequence
  var seqRows = data.sequence || [];
  html += '<div style="font-size:.8rem;font-weight:700;color:var(--text-muted);margin-bottom:6px;letter-spacing:.04em;">CALL SEQUENCE (' + seqRows.length + ' match' + (seqRows.length !== 1 ? 'es' : '') + ' of ' + data.totalEntries + ' total)</div>';
  html += '<div style="font-family:monospace;font-size:.75rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:8px;overflow-y:auto;max-height:420px;">';

  if (seqRows.length === 0) {
    html += '<div style="padding:20px;color:var(--text-muted);text-align:center;">None of the FSM transition methods were found in this log.</div>';
  }
  for (var si = 0; si < seqRows.length; si++) {
    var row = seqRows[si];
    var e = row.entry;
    var kwIdxs = row.kwIndices;
    var rowColor = palette[kwIdxs[0] % palette.length];
    var isViolation = row.violation;

    var entryText = e.className
      ? e.className + ' -> ' + e.returnType + ' ' + e.methodName + '(' + e.args + ')'
      : e.sig;

    var highlighted = escHtml(entryText);
    for (var hi = 0; hi < kwIdxs.length; hi++) {
      var t2 = data.transitions[kwIdxs[hi]];
      if (!t2) continue;
      var mname = t2.method.replace(new RegExp('[.*+?^$' + '{}()|[\\\\]\\\\\\\\]', 'g'), function(c) { return '\\\\' + c; });
      var hcolor = palette[kwIdxs[hi] % palette.length];
      highlighted = highlighted.replace(new RegExp('(' + mname + ')', 'gi'),
        function(_, m) { return '<mark style="background:' + hcolor + '33;color:' + hcolor + ';border-radius:2px;padding:0 1px;font-weight:bold;">' + m + '</mark>'; });
    }

    var badges = kwIdxs.map(function(idx) {
      var t3 = data.transitions[idx];
      var c = palette[idx % palette.length];
      return '<span style="font-size:.67rem;padding:0 4px;border-radius:3px;background:' + c + '22;color:' + c + ';border:1px solid ' + c + '55;margin-right:3px;">'
        + escHtml(t3 ? t3.method : '') + '</span>';
    }).join('');

    var violBadge = isViolation
      ? '<span style="font-size:.67rem;padding:0 4px;border-radius:3px;background:#ef444422;color:#ef4444;border:1px solid #ef444455;margin-right:3px;">VIOLATION</span>'
      : '';

    var rowBg = isViolation ? 'background:#7f1d1d18;' : '';
    html += '<div style="display:flex;gap:10px;align-items:baseline;padding:5px 12px;border-bottom:1px solid rgba(255,255,255,.04);border-left:3px solid ' + (isViolation ? '#ef4444' : rowColor) + ';' + rowBg + '">'
      + '<span style="color:var(--text-muted);flex-shrink:0;min-width:28px;text-align:right;font-size:.7rem;">#' + (si + 1) + '</span>'
      + '<div style="min-width:0;flex:1;">'
      + '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + escHtml(entryText) + '">' + highlighted + '</div>'
      + '<div style="margin-top:2px;">' + violBadge + badges + '</div>'
      + '</div></div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

// ── Jimple Decompiler ─────────────────────────────────────────────────────────

var _jimpleAllFiles = [];   // [{name, path}] full list from last load
var _jimpleSootCtrl = null; // AbortController for SSE

function jimpleBrowseApk() {
  jimpleApkBrowseLoad(document.getElementById('jimpleApkPath').value.trim() || '');
  document.getElementById('jimpleApkBrowserModal').style.display = 'flex';
}

function jimpleApkBrowseLoad(dir) {
  var url = '/api/browse-apks?dir=' + encodeURIComponent(dir || '');
  fetch(url).then(function(r){ return r.json(); }).then(function(d) {
    document.getElementById('jimpleApkBrowserPath').textContent = d.current;
    var list = document.getElementById('jimpleApkBrowserList');
    list.innerHTML = '';
    if (d.parent) {
      var up = document.createElement('div');
      up.className = 'dir-item up';
      up.innerHTML = '<span class="icon">⬆</span><span>.. (up)</span>';
      up.addEventListener('click', function(){ jimpleApkBrowseLoad(d.parent); });
      list.appendChild(up);
    }
    d.dirs.forEach(function(dir) {
      var el = document.createElement('div');
      el.className = 'dir-item';
      el.innerHTML = '<span class="icon">📁</span><span>' + dir.name + '</span>';
      el.addEventListener('click', function(){ jimpleApkBrowseLoad(dir.path); });
      list.appendChild(el);
    });
    d.apks.forEach(function(apk) {
      var el = document.createElement('div');
      el.className = 'dir-item';
      el.innerHTML = '<span class="icon">📦</span><span style="color:var(--accent-no-ads);">' + apk.name + '</span>';
      el.addEventListener('click', function(){
        document.getElementById('jimpleApkPath').value = apk.path;
        document.getElementById('jimpleApkBrowserModal').style.display = 'none';
      });
      list.appendChild(el);
    });
    if (!d.dirs.length && !d.apks.length) {
      list.innerHTML = '<div class="empty">No APK files or subdirectories here.</div>';
    }
  }).catch(function(e){ document.getElementById('jimpleApkBrowserList').innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; });
}

function jimpleBrowseOutput() {
  // Open the directory browser modal and on select populate output dir
  _jimpleBrowseTarget = 'output';
  openBrowserFor('jimpleOutputDir');
}

var _jimpleBrowseTarget = null;

function openBrowserFor(inputId) {
  // Reuse the existing directory browser modal
  var _jimpleBrowseInputId = inputId; // unused beyond setting override
  var startPath = document.getElementById(inputId).value.trim() || '';
  loadBrowserDir(startPath || null);
  document.getElementById('browserModal').classList.add('open');
  // Override selectDir to write back to our input
  _jimpleBrowserOverride = inputId;
}

var _jimpleBrowserOverride = null;

// Patch selectDir to support jimple target
var _origSelectDir = null;
(function() {
  // defer until DOM ready
  setTimeout(function() {
    _origSelectDir = selectDir;
    selectDir = function() {
      if (_jimpleBrowserOverride) {
        var el = document.getElementById(_jimpleBrowserOverride);
        if (el && currentBrowsePath) el.value = currentBrowsePath;
        _jimpleBrowserOverride = null;
        closeBrowser();
      } else {
        _origSelectDir();
      }
    };
  }, 0);
})();

function jimpleRunSoot() {
  var apkPath   = document.getElementById('jimpleApkPath').value.trim();
  var outputDir = document.getElementById('jimpleOutputDir').value.trim();
  var jarsPath  = document.getElementById('jimpleAndroidJars').value.trim();
  if (!apkPath) { alert('APK file path is required.'); return; }

  var logEl   = document.getElementById('jimpleLog');
  var logWrap = document.getElementById('jimpleLogWrap');
  var doneMsg = document.getElementById('jimpleDoneMsg');
  var runBtn  = document.getElementById('jimpleRunBtn');
  var cancelBtn = document.getElementById('jimpleCancelBtn');
  var statusEl  = document.getElementById('jimpleStatus');

  logEl.textContent = '';
  logWrap.style.display = 'block';
  doneMsg.style.display = 'none';
  runBtn.disabled = true;
  cancelBtn.style.display = 'inline-block';
  statusEl.textContent = 'Running Soot…';

  _jimpleSootCtrl = new AbortController();

  fetch('/api/soot/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apkPath: apkPath, outputDir: outputDir, androidJarsPath: jarsPath }),
    signal: _jimpleSootCtrl.signal
  }).then(function(res) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    function pump() {
      return reader.read().then(function(chunk) {
        if (chunk.done) {
          runBtn.disabled = false;
          cancelBtn.style.display = 'none';
          statusEl.textContent = '';
          return;
        }
        buf += decoder.decode(chunk.value, { stream: true });
        var lines = buf.split('\\n');
        buf = lines.pop();
        lines.forEach(function(line) {
          if (!line.startsWith('data: ')) return;
          try {
            var ev = JSON.parse(line.slice(6));
            if (ev.type === 'log') {
              var span = document.createElement('span');
              span.style.color = ev.message && ev.message.toLowerCase().includes('error') ? '#f87171' : '#a8d8a8';
              span.textContent = ev.message + '\\n';
              logEl.appendChild(span);
              logEl.scrollTop = logEl.scrollHeight;
            } else if (ev.type === 'done') {
              runBtn.disabled = false;
              cancelBtn.style.display = 'none';
              statusEl.textContent = '';
              doneMsg.style.display = 'block';
              var outDir = outputDir || '~/sootOutput';
              doneMsg.textContent = '✓ Soot completed. Jimple files written to: ' + outDir;
              document.getElementById('jimpleViewDir').value = outDir;
              jimpleListFiles();
              jimpleBuildCfgFromDir(outDir);
            } else if (ev.type === 'error') {
              runBtn.disabled = false;
              cancelBtn.style.display = 'none';
              statusEl.textContent = 'Error: ' + ev.message;
            }
          } catch(e) {}
        });
        return pump();
      });
    }
    return pump();
  }).catch(function(e) {
    if (e.name !== 'AbortError') {
      statusEl.textContent = 'Error: ' + e.message;
    }
    runBtn.disabled = false;
    cancelBtn.style.display = 'none';
  });
}

function jimpleCancel() {
  if (_jimpleSootCtrl) _jimpleSootCtrl.abort();
  document.getElementById('jimpleStatus').textContent = 'Cancelled.';
  document.getElementById('jimpleRunBtn').disabled = false;
  document.getElementById('jimpleCancelBtn').style.display = 'none';
}

function jimpleListFiles() {
  var dir = document.getElementById('jimpleViewDir').value.trim();
  if (!dir) return;
  document.getElementById('jimpleViewStatus').textContent = 'Loading…';
  document.getElementById('jimpleFileList').style.display = 'none';

  fetch('/api/soot/list-jimple', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath: dir })
  })
  .then(function(r){ return r.json(); })
  .then(function(d) {
    if (d.error) { document.getElementById('jimpleViewStatus').textContent = 'Error: ' + d.error; return; }
    _jimpleAllFiles = d.files || [];
    document.getElementById('jimpleFileSearch').value = '';
    document.getElementById('jimpleFileList').style.display = 'block';
    jimpleRenderFileList(_jimpleAllFiles);
    // Batch-load all file contents into _jimpleCfgSources so the AI chat can see them
    var statusEl = document.getElementById('jimpleViewStatus');
    statusEl.textContent = _jimpleAllFiles.length + ' .jimple file(s) found — loading for AI chat…';
    var BATCH = 10, idx = 0;
    function fetchViewBatch() {
      if (idx >= _jimpleAllFiles.length) {
        statusEl.textContent = _jimpleAllFiles.length + ' .jimple file(s) found';
        return;
      }
      var batch = _jimpleAllFiles.slice(idx, idx + BATCH);
      idx += BATCH;
      statusEl.textContent = _jimpleAllFiles.length + ' .jimple file(s) found — loading for AI chat (' + Math.min(idx, _jimpleAllFiles.length) + '/' + _jimpleAllFiles.length + ')…';
      Promise.all(batch.map(function(f) {
        return fetch('/api/soot/read-jimple', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: dir, className: f.name })
        }).then(function(r){ return r.json(); }).then(function(data){ return { name: f.name, content: data.content || '' }; })
        .catch(function(){ return { name: f.name, content: '' }; });
      })).then(function(results) {
        results.forEach(function(r) {
          if (!r.content) return;
          var parsed = jimpleParseCfg(r.content);
          Object.keys(parsed).forEach(function(sig) {
            _jimpleCfgMethods[sig] = parsed[sig];
            _jimpleCfgSources[sig] = r.content;
          });
          // If no methods parsed, still store the raw source keyed by filename
          if (!Object.keys(parsed).length) {
            _jimpleCfgSources['__file__' + r.name] = r.content;
          }
        });
        fetchViewBatch();
      });
    }
    fetchViewBatch();
  })
  .catch(function(e){ document.getElementById('jimpleViewStatus').textContent = 'Error: ' + e.message; });
}

function jimpleFilterFiles() {
  var q = document.getElementById('jimpleFileSearch').value.toLowerCase();
  var filtered = _jimpleAllFiles.filter(function(f){ return f.name.toLowerCase().includes(q); });
  jimpleRenderFileList(filtered);
}

function jimpleRenderFileList(files) {
  var el = document.getElementById('jimpleFileItems');
  el.innerHTML = '';
  if (!files.length) {
    var empty = document.createElement('div');
    empty.style.cssText = 'padding:8px;font-size:.75rem;color:var(--text-muted);';
    empty.textContent = 'No files match.';
    el.appendChild(empty);
    return;
  }
  files.forEach(function(f) {
    var item = document.createElement('div');
    item.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:.75rem;font-family:monospace;border-bottom:1px solid var(--card-border);color:var(--text);';
    item.textContent = f.name;
    item.addEventListener('mouseover', function(){ item.style.background = 'var(--surface)'; });
    item.addEventListener('mouseout',  function(){ item.style.background = ''; });
    item.addEventListener('click',     function(){ jimpleLoadFile(f.name); });
    el.appendChild(item);
  });
}

var _jimpleCurrentCode = '';

function jimpleLoadFile(name) {
  var dir = document.getElementById('jimpleViewDir').value.trim();
  document.getElementById('jimpleViewStatus').textContent = 'Loading ' + name + '…';
  document.getElementById('jimpleCodeWrap').style.display = 'none';

  fetch('/api/soot/read-jimple', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath: dir, className: name })
  })
  .then(function(r){ return r.json(); })
  .then(function(d) {
    if (d.error) { document.getElementById('jimpleViewStatus').textContent = 'Error: ' + d.error; return; }
    _jimpleCurrentCode = d.content || '';
    document.getElementById('jimpleCodeTitle').textContent = name;
    document.getElementById('jimpleCodeView').innerHTML = jimpleHighlight(_jimpleCurrentCode);
    document.getElementById('jimpleCodeWrap').style.display = 'block';
    document.getElementById('jimpleViewStatus').textContent = '';
    // Ensure this file is also available in the AI chat context
    if (_jimpleCurrentCode) {
      var parsed = jimpleParseCfg(_jimpleCurrentCode);
      Object.keys(parsed).forEach(function(sig) {
        _jimpleCfgMethods[sig] = parsed[sig];
        _jimpleCfgSources[sig] = _jimpleCurrentCode;
      });
      if (!Object.keys(parsed).length) {
        _jimpleCfgSources['__file__' + name] = _jimpleCurrentCode;
      }
    }
  })
  .catch(function(e){ document.getElementById('jimpleViewStatus').textContent = 'Error: ' + e.message; });
}

function jimpleCopyCode() {
  if (!_jimpleCurrentCode) return;
  navigator.clipboard.writeText(_jimpleCurrentCode).then(function(){
    var btn = document.querySelector('#jimpleCodeWrap button');
    var orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(function(){ btn.textContent = orig; }, 1500);
  });
}

function jimpleHighlight(code) {
  var lines = code.split('\\n');
  return lines.map(function(line, i) {
    var num = '<span style="color:#4a5568;user-select:none;display:inline-block;width:3em;text-align:right;padding-right:1em;">' + (i+1) + '</span>';
    return '<div>' + num + jimpleHighlightLine(escapeHtml(line)) + '</div>';
  }).join('');
}

function jimpleHighlightLine(line) {
  // Apply syntax highlighting via regex replacements in priority order
  // Comments: replace // ... to end of line
  var commentIdx = line.indexOf('//');
  if (commentIdx >= 0) {
    line = line.slice(0, commentIdx) + '<span style="color:#718096;font-style:italic;">' + line.slice(commentIdx) + '</span>';
    return line; // rest of replacements irrelevant inside comment
  }
  // String literals
  line = line.replace(/"([^"]*)"/g, '<span style="color:#f6ad55;">"$1"</span>');
  // Invoke types
  line = line.replace(/\b(staticinvoke|specialinvoke|virtualinvoke|interfaceinvoke)\b/g, '<span style="color:#b794f4;">$1</span>');
  // Keywords
  line = line.replace(/\b(if|goto|return|throw|nop|new|instanceof|cast|switch|case|default|catch|newarray|newmultiarray)\b/g, '<span style="color:#63b3ed;">$1</span>');
  // Modifiers
  line = line.replace(/\b(public|private|protected|static|final|abstract|synchronized|native|transient|volatile)\b/g, '<span style="color:#76e4f7;">$1</span>');
  // Primitive types
  line = line.replace(/\b(void|int|long|boolean|float|double|byte|short|char)\b/g, '<span style="color:#9ae6b4;">$1</span>');
  // Class refs <...> (already HTML-escaped as &lt;...&gt;)
  line = line.replace(/(&lt;[^&]*&gt;)/g, '<span style="color:#68d391;">$1</span>');
  return line;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Jimple CFG Visualization ──────────────────────────────────────────────────

var _jimpleCfgMethods = {};   // { methodSig: [ {id, stmts[], succs:[{id,label}]} ] }
var _jimpleCfgSources = {};   // { methodSig: rawJimpleText }
var _jimpleCfgZoom = 1.0;
var _jimpleCfgPan  = { x: 20, y: 20 };
var _jimpleCfgDrag = null;

// Populate CFG panel from all jimple files in the given output directory
function jimpleBuildCfgFromDir(outputDir) {
  if (!outputDir) return;
  document.getElementById('jimpleCfgStatus').textContent = 'Loading CFGs…';
  document.getElementById('jimpleCfgPanel').style.display = 'block';
  document.getElementById('jimpleCfgRoot').innerHTML = '';
  jimpleCfgSetupPanZoom();

  fetch('/api/soot/list-jimple', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath: outputDir })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    var files = d.files || [];
    if (!files.length) {
      document.getElementById('jimpleCfgStatus').textContent = 'No .jimple files found in output directory.';
      return;
    }
    // Fetch files in batches of 10 to avoid ERR_INSUFFICIENT_RESOURCES
    _jimpleCfgMethods = {};
    _jimpleCfgSources = {};
    var statusEl = document.getElementById('jimpleCfgStatus');
    var BATCH = 10;
    var idx = 0;
    function fetchBatch() {
      if (idx >= files.length) {
        // Done — populate dropdown
        var sigs = Object.keys(_jimpleCfgMethods).sort();
        var sel = document.getElementById('jimpleCfgMethodSelect');
        sel.innerHTML = '';
        if (!sigs.length) {
          statusEl.textContent = 'No methods with control flow found.';
          return;
        }
        sigs.forEach(function(s) {
          var opt = document.createElement('option');
          opt.value = s;
          opt.textContent = s;
          sel.appendChild(opt);
        });
        _jimpleCfgZoom = 1.0;
        _jimpleCfgPan  = { x: 20, y: 20 };
        statusEl.textContent = sigs.length + ' method(s) found across ' + files.length + ' class(es)';
        jimpleRenderSelectedCfg();
        return;
      }
      var batch = files.slice(idx, idx + BATCH);
      idx += BATCH;
      statusEl.textContent = 'Loading CFGs… (' + Math.min(idx, files.length) + '/' + files.length + ')';
      Promise.all(batch.map(function(f) {
        return fetch('/api/soot/read-jimple', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: outputDir, className: f.name })
        }).then(function(r) { return r.json(); }).then(function(data) {
          return data.content || '';
        }).catch(function() { return ''; });
      })).then(function(contents) {
        contents.forEach(function(content) {
          if (!content) return;
          var parsed = jimpleParseCfg(content);
          Object.keys(parsed).forEach(function(sig) {
            _jimpleCfgMethods[sig] = parsed[sig];
            _jimpleCfgSources[sig] = content;
          });
        });
        fetchBatch();
      });
    }
    fetchBatch();
  })
  .catch(function(e) {
    document.getElementById('jimpleCfgStatus').textContent = 'Error: ' + e.message;
  });
}

function jimpleRenderSelectedCfg() {
  var sig = document.getElementById('jimpleCfgMethodSelect').value;
  if (!sig || !_jimpleCfgMethods[sig]) return;
  _jimpleCfgZoom = 1.0;
  _jimpleCfgPan  = { x: 0, y: 0 };
  jimpleDrawCfg(_jimpleCfgMethods[sig], sig);
}

// ── CFG parser ────────────────────────────────────────────────────────────────
// Parses Jimple source into basic blocks with successor edges.
function jimpleParseCfg(src) {
  var result = {};
  var methodBodies = jimpleExtractMethods(src);
  methodBodies.forEach(function(mb) {
    var blocks = jimpleBuildBlocks(mb.body);
    if (blocks.length > 0) result[mb.sig] = blocks;
  });
  return result;
}

function jimpleExtractMethods(src) {
  var results = [];
  var lines = src.split('\\n');
  // State machine: find lines inside a class body
  var inClass = false, classDepth = 0;
  var inMethod = false, methodDepth = 0, methodSig = '', bodyLines = [];

  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var trimmed = raw.trim();
    var opens = (raw.split('{').length - 1);
    var closes = (raw.split('}').length - 1);

    if (!inClass) {
      if (opens > 0) { inClass = true; classDepth = opens - closes; }
      continue;
    }

    if (!inMethod) {
      classDepth += opens - closes;
      if (classDepth <= 0) { inClass = false; continue; }
      // detect method opening: line ends with { or next non-blank does, and line looks like a method decl
      var _cfgParen = trimmed.indexOf('(');
      var _cfgFirstWord = _cfgParen >= 0 ? trimmed.slice(0, _cfgParen).trim().split(' ').pop() : '';
      var _cfgCtrlKw = { 'if':1,'for':1,'while':1,'switch':1,'catch':1,'try':1 };
      var isMethodDecl = opens > 0 && raw.indexOf('(') >= 0 && !_cfgCtrlKw[_cfgFirstWord] && trimmed.indexOf('//') !== 0 && trimmed !== '{';
      if (isMethodDecl && opens > 0) {
        // signature = trim off the {
        var _braceIdx = trimmed.indexOf('{');
        methodSig = (_braceIdx >= 0 ? trimmed.slice(0, _braceIdx) : trimmed).trim();
        inMethod = true;
        methodDepth = opens - closes;
        bodyLines = [];
        // if depth already back to 0 on same line (empty method), close now
        if (methodDepth <= 0) {
          results.push({ sig: methodSig, body: bodyLines });
          inMethod = false;
          methodDepth = 0;
        }
      }
    } else {
      methodDepth += opens - closes;
      if (methodDepth <= 0) {
        results.push({ sig: methodSig, body: bodyLines });
        inMethod = false;
        methodDepth = 0;
        classDepth -= (closes - opens); // already counted above; re-adjust
      } else {
        bodyLines.push(raw);
      }
    }
  }
  return results;
}

// Extract a word token starting at position 0 of s (alphanumeric + _$)
function _cfgWord(s) {
  var end = 0;
  while (end < s.length && /[a-zA-Z0-9_$]/.test(s[end])) end++;
  return s.slice(0, end);
}

function jimpleBuildBlocks(bodyLines) {
  if (!bodyLines || !bodyLines.length) return [];

  // Pre-scan labels
  var labels = {};
  bodyLines.forEach(function(l, i) {
    var t = l.trim();
    // label: word followed by colon, nothing else
    if (t.slice(-1) === ':' && t.indexOf(' ') < 0 && t.indexOf('(') < 0) {
      labels[t.slice(0, -1)] = i;
    }
  });

  var blocks = [];
  var cur = null;
  function newBlock(id) { cur = { id: id, stmts: [], succs: [] }; blocks.push(cur); }
  newBlock(0);

  for (var i = 0; i < bodyLines.length; i++) {
    var line = bodyLines[i].trim();
    if (!line) continue;

    // Label line: ends with ':' and has no spaces or parens
    if (line.slice(-1) === ':' && line.indexOf(' ') < 0 && line.indexOf('(') < 0) {
      var lname = line.slice(0, -1);
      var lid = 'L' + lname;
      if (cur && cur.stmts.length > 0) cur.succs.push({ id: lid, label: '' });
      newBlock(lid);
      labels[lname] = lid;
      continue;
    }

    cur.stmts.push(line);

    // goto <label>;
    if (line.indexOf('goto ') === 0) {
      var gTarget = line.slice(5).replace(';', '').trim();
      cur.succs.push({ id: 'L' + gTarget, label: 'goto' });
      newBlock(blocks.length);
      continue;
    }

    // if <cond> goto <label>;
    if (line.indexOf('if ') === 0) {
      var gotoIdx = line.lastIndexOf(' goto ');
      if (gotoIdx >= 0) {
        var ifTarget = line.slice(gotoIdx + 6).replace(';', '').trim();
        cur.succs.push({ id: 'L' + ifTarget, label: 'true' });
        var nextId = blocks.length;
        cur.succs.push({ id: nextId, label: 'false' });
        newBlock(nextId);
        continue;
      }
    }

    // return / throw
    var firstWord = _cfgWord(line);
    if (firstWord === 'return' || firstWord === 'throw') {
      newBlock(blocks.length);
      continue;
    }

    // tableswitch / lookupswitch
    if (firstWord === 'tableswitch' || firstWord === 'lookupswitch') {
      var j = i + 1;
      while (j < bodyLines.length && bodyLines[j].trim() !== '}') {
        var ct = bodyLines[j].trim();
        var gotoPos = ct.indexOf(' goto ');
        if (gotoPos >= 0 && (ct.indexOf('case ') === 0 || ct.indexOf('default') === 0)) {
          var cLabel = ct.slice(gotoPos + 6).replace(';', '').trim();
          var cName  = ct.slice(0, gotoPos).replace('case ', '').replace(':', '').trim();
          cur.succs.push({ id: 'L' + cLabel, label: cName });
        }
        j++;
      }
      i = j;
      newBlock(blocks.length);
      continue;
    }
  }

  if (cur && cur.stmts.length === 0 && cur.succs.length === 0 && blocks.length > 1) {
    blocks.pop();
  }
  return blocks;
}

// ── CFG renderer (SVG hierarchical layout) ────────────────────────────────────
var _jimpleCfgNodeW = 220;
var _jimpleCfgNodeH_base = 22; // per statement line
var _jimpleCfgNodePad = 8;
var _jimpleCfgLevelGap = 70;
var _jimpleCfgSibGap  = 30;

function jimpleDrawCfg(blocks, sig) {
  var svg  = document.getElementById('jimpleCfgSvg');
  var root = document.getElementById('jimpleCfgRoot');
  root.innerHTML = '';
  if (!blocks || !blocks.length) {
    document.getElementById('jimpleCfgStatus').textContent = 'No blocks to render.';
    return;
  }
  document.getElementById('jimpleCfgStatus').textContent = sig + ' — ' + blocks.length + ' basic block(s)';

  // Assign layout positions via simple layered layout
  var nodeW = _jimpleCfgNodeW;
  var positions = jimpleCfgLayout(blocks, nodeW);

  // Compute bounding box and normalize positions to origin (0,0)
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  blocks.forEach(function(b) {
    var p = positions[b.id];
    if (!p) return;
    var h = jimpleCfgNodeHeight(b);
    if (p.x         < minX) minX = p.x;
    if (p.y         < minY) minY = p.y;
    if (p.x + nodeW > maxX) maxX = p.x + nodeW;
    if (p.y + h     > maxY) maxY = p.y + h;
  });
  // Shift all positions so content starts at (0,0)
  blocks.forEach(function(b) {
    if (positions[b.id]) { positions[b.id].x -= minX; positions[b.id].y -= minY; }
  });
  var contentW = maxX - minX;
  var contentH = maxY - minY;
  var PAD = 20;
  var svgW = contentW + PAD * 2;
  var svgH = contentH + PAD * 2;
  // Shift positions by padding
  blocks.forEach(function(b) {
    if (positions[b.id]) { positions[b.id].x += PAD; positions[b.id].y += PAD; }
  });
  var fitW = svgW;
  var fitH = svgH;

  // Draw edges first (so nodes render on top)
  var edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  root.appendChild(edgeGroup);
  var nodeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  root.appendChild(nodeGroup);

  // Build id → block map
  var bmap = {};
  blocks.forEach(function(b) { bmap[b.id] = b; });

  blocks.forEach(function(b) {
    var sp = positions[b.id];
    if (!sp) return;
    var sh = jimpleCfgNodeHeight(b);
    var sx = sp.x + nodeW / 2;
    var sy_bottom = sp.y + sh;

    b.succs.forEach(function(succ) {
      var tp = positions[succ.id];
      if (!tp) return;
      var tb = bmap[succ.id];
      var th = tb ? jimpleCfgNodeHeight(tb) : 0;
      var tx = tp.x + nodeW / 2;
      var ty_top = tp.y;

      var color = succ.label === 'true' || succ.label === 'goto' ? '#10b981'
                : succ.label === 'false' ? '#ef4444'
                : '#64748b';
      var markerId = succ.label === 'true' || succ.label === 'goto' ? 'cfgArrowTrue'
                   : succ.label === 'false' ? 'cfgArrowFalse'
                   : 'cfgArrow';

      // Draw bezier curve edge
      var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

      // back-edge detection (target is above source)
      var isBack = ty_top < sp.y;
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      var d;
      if (isBack) {
        // Route around the side
        var sideX = sp.x - 28;
        d = 'M ' + sx + ' ' + sy_bottom +
            ' C ' + sx + ' ' + (sy_bottom + 20) + ' ' + sideX + ' ' + (sy_bottom + 20) + ' ' + sideX + ' ' + ((sy_bottom + ty_top) / 2) +
            ' S ' + sideX + ' ' + (ty_top - 20) + ' ' + tx + ' ' + ty_top;
      } else {
        var cy1 = sy_bottom + _jimpleCfgLevelGap * 0.4;
        var cy2 = ty_top    - _jimpleCfgLevelGap * 0.4;
        d = 'M ' + sx + ' ' + sy_bottom + ' C ' + sx + ' ' + cy1 + ' ' + tx + ' ' + cy2 + ' ' + tx + ' ' + ty_top;
      }
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('marker-end', 'url(#' + markerId + ')');
      g.appendChild(path);

      // Edge label
      if (succ.label && succ.label !== 'goto') {
        var mx = (sx + tx) / 2;
        var my = (sy_bottom + ty_top) / 2;
        var lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('x', mx + 4);
        lbl.setAttribute('y', my);
        lbl.setAttribute('font-size', '10');
        lbl.setAttribute('fill', color);
        lbl.setAttribute('font-family', 'monospace');
        lbl.textContent = succ.label;
        g.appendChild(lbl);
      }
      edgeGroup.appendChild(g);
    });
  });

  // Draw nodes
  blocks.forEach(function(b) {
    var p = positions[b.id];
    if (!p) return;
    var h = jimpleCfgNodeHeight(b);
    var isEntry  = b.id === blocks[0].id;
    var isExit   = b.succs.length === 0;
    var fillColor   = isEntry ? 'rgba(16,185,129,0.18)' : isExit ? 'rgba(239,68,68,0.15)' : 'rgba(30,41,59,0.92)';
    var strokeColor = isEntry ? '#10b981' : isExit ? '#ef4444' : '#334155';

    var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', p.x);
    rect.setAttribute('y', p.y);
    rect.setAttribute('width',  nodeW);
    rect.setAttribute('height', h);
    rect.setAttribute('rx', '6');
    rect.setAttribute('fill',   fillColor);
    rect.setAttribute('stroke', strokeColor);
    rect.setAttribute('stroke-width', '1.5');
    g.appendChild(rect);

    // Block id label (header)
    var idStr = String(b.id);
    var idTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    idTxt.setAttribute('x', p.x + _jimpleCfgNodePad);
    idTxt.setAttribute('y', p.y + 14);
    idTxt.setAttribute('font-size', '10');
    idTxt.setAttribute('font-weight', 'bold');
    idTxt.setAttribute('fill', isEntry ? '#10b981' : isExit ? '#f87171' : '#94a3b8');
    idTxt.setAttribute('font-family', 'monospace');
    idTxt.textContent = (isEntry ? '▶ ' : isExit ? '■ ' : '') + idStr;
    g.appendChild(idTxt);

    // Separator line
    var sep = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    sep.setAttribute('x1', p.x);
    sep.setAttribute('y1', p.y + 20);
    sep.setAttribute('x2', p.x + nodeW);
    sep.setAttribute('y2', p.y + 20);
    sep.setAttribute('stroke', strokeColor);
    sep.setAttribute('stroke-width', '0.5');
    g.appendChild(sep);

    // Statement lines — truncated to fit
    var maxChars = Math.floor((nodeW - _jimpleCfgNodePad * 2) / 6.2);
    b.stmts.forEach(function(stmt, si) {
      var txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', p.x + _jimpleCfgNodePad);
      txt.setAttribute('y', p.y + 20 + _jimpleCfgNodePad + (si + 1) * 13);
      txt.setAttribute('font-size', '9.5');
      txt.setAttribute('fill', '#cbd5e1');
      txt.setAttribute('font-family', 'monospace');
      var display = stmt.length > maxChars ? stmt.slice(0, maxChars - 1) + '…' : stmt;
      txt.textContent = display;
      // Tooltip for full text
      var title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = stmt;
      txt.appendChild(title);
      g.appendChild(txt);
    });

    nodeGroup.appendChild(g);
  });

  // Store for fullscreen reuse
  _jimpleCfgFsContentW = fitW; _jimpleCfgFsContentH = fitH;
  _jimpleCfgFsOriginX  = 0;    _jimpleCfgFsOriginY  = 0;
  // Fit normalized content into the viewport
  jimpleCfgFit(fitW, fitH, 0, 0);
}

function jimpleCfgFit(contentW, contentH) {
  requestAnimationFrame(function() {
    var vp = document.getElementById('jimpleCfgViewport');
    if (!vp) return;
    var vpW = vp.clientWidth  || 900;
    var vpH = vp.clientHeight || 580;
    if (vpW < 10 || vpH < 10) return;
    var scaleX = vpW / contentW;
    var scaleY = vpH / contentH;
    _jimpleCfgZoom = Math.max(0.05, Math.min(scaleX, scaleY, 3.0));
    _jimpleCfgPan.x = (vpW - contentW * _jimpleCfgZoom) / 2;
    _jimpleCfgPan.y = (vpH - contentH * _jimpleCfgZoom) / 2;
    jimpleCfgApplyTransform();
  });
}

function jimpleCfgNodeHeight(b) {
  return 20 + _jimpleCfgNodePad + (b.stmts.length || 1) * 13 + _jimpleCfgNodePad;
}

// Simple top-down layered layout using BFS levels
function jimpleCfgLayout(blocks, nodeW) {
  if (!blocks.length) return {};
  var bmap = {};
  blocks.forEach(function(b) { bmap[b.id] = b; });

  // BFS from entry to assign levels
  var levels = {};
  var visited = {};
  var queue = [{ id: blocks[0].id, level: 0 }];
  visited[blocks[0].id] = true;
  var maxLevel = 0;

  while (queue.length) {
    var item = queue.shift();
    levels[item.id] = item.level;
    if (item.level > maxLevel) maxLevel = item.level;
    var b = bmap[item.id];
    if (b) {
      b.succs.forEach(function(s) {
        if (!visited[s.id] && bmap[s.id]) {
          visited[s.id] = true;
          queue.push({ id: s.id, level: item.level + 1 });
        }
      });
    }
  }

  // Any unreached blocks get placed at the end
  blocks.forEach(function(b) {
    if (levels[b.id] === undefined) { maxLevel++; levels[b.id] = maxLevel; }
  });

  // Group by level
  var byLevel = {};
  blocks.forEach(function(b) {
    var lv = levels[b.id];
    if (!byLevel[lv]) byLevel[lv] = [];
    byLevel[lv].push(b.id);
  });

  // Assign x positions by centering each level
  var positions = {};
  var yOffset = 20;
  var sibGap = _jimpleCfgSibGap;
  var levelGap = _jimpleCfgLevelGap;

  // Compute cumulative y per level (needs node heights)
  var levelY = {};
  var curY = yOffset;
  for (var lv = 0; lv <= maxLevel; lv++) {
    levelY[lv] = curY;
    var ids = byLevel[lv] || [];
    var maxH = 0;
    ids.forEach(function(id) {
      var b = bmap[id];
      if (b) { var h = jimpleCfgNodeHeight(b); if (h > maxH) maxH = h; }
    });
    curY += maxH + levelGap;
  }

  // Find the widest level to determine canvas width
  var maxNodesInLevel = 0;
  for (var lv2 = 0; lv2 <= maxLevel; lv2++) {
    var cnt = (byLevel[lv2] || []).length;
    if (cnt > maxNodesInLevel) maxNodesInLevel = cnt;
  }
  var canvasW = Math.max(maxNodesInLevel * (nodeW + sibGap) - sibGap + 40, nodeW + 40);

  // Assign x: center each level within canvasW
  for (var lv3 = 0; lv3 <= maxLevel; lv3++) {
    var ids3 = byLevel[lv3] || [];
    var rowW = ids3.length * nodeW + (ids3.length - 1) * sibGap;
    var startX = (canvasW - rowW) / 2;
    ids3.forEach(function(id, idx) {
      positions[id] = {
        x: startX + idx * (nodeW + sibGap),
        y: levelY[lv3]
      };
    });
  }

  return positions;
}

// ── CFG pan/zoom ──────────────────────────────────────────────────────────────
var _jimpleCfgFsZoom = 1.0;
var _jimpleCfgFsPan  = { x: 0, y: 0 };
var _jimpleCfgFsDrag = null;
var _jimpleCfgFsContentW = 0, _jimpleCfgFsContentH = 0, _jimpleCfgFsOriginX = 0, _jimpleCfgFsOriginY = 0;

function jimpleCfgApplyTransform(fs) {
  if (fs) {
    var root = document.getElementById('jimpleCfgFsRoot');
    if (root) root.setAttribute('transform', 'translate(' + _jimpleCfgFsPan.x + ',' + _jimpleCfgFsPan.y + ') scale(' + _jimpleCfgFsZoom + ')');
  } else {
    var root2 = document.getElementById('jimpleCfgRoot');
    if (root2) root2.setAttribute('transform', 'translate(' + _jimpleCfgPan.x + ',' + _jimpleCfgPan.y + ') scale(' + _jimpleCfgZoom + ')');
  }
}

function jimpleCfgZoomIn(fs)  {
  if (fs) { _jimpleCfgFsZoom = Math.min(4.0, _jimpleCfgFsZoom * 1.2); jimpleCfgApplyTransform(true); }
  else    { _jimpleCfgZoom   = Math.min(4.0, _jimpleCfgZoom   * 1.2); jimpleCfgApplyTransform(); }
}
function jimpleCfgZoomOut(fs) {
  if (fs) { _jimpleCfgFsZoom = Math.max(0.05, _jimpleCfgFsZoom / 1.2); jimpleCfgApplyTransform(true); }
  else    { _jimpleCfgZoom   = Math.max(0.05, _jimpleCfgZoom   / 1.2); jimpleCfgApplyTransform(); }
}
function jimpleCfgReset(fs) {
  if (fs) { jimpleCfgFitFs(); }
  else    { jimpleRenderSelectedCfg(); }
}

function jimpleCfgFitFs() {
  requestAnimationFrame(function() {
    var vp = document.getElementById('jimpleCfgFsViewport');
    if (!vp) return;
    var vpW = vp.clientWidth  || window.innerWidth;
    var vpH = vp.clientHeight || window.innerHeight - 50;
    if (vpW < 10 || vpH < 10) return;
    var scaleX = vpW / _jimpleCfgFsContentW;
    var scaleY = vpH / _jimpleCfgFsContentH;
    _jimpleCfgFsZoom = Math.max(0.05, Math.min(scaleX, scaleY, 3.0));
    _jimpleCfgFsPan.x = (vpW - _jimpleCfgFsContentW * _jimpleCfgFsZoom) / 2;
    _jimpleCfgFsPan.y = (vpH - _jimpleCfgFsContentH * _jimpleCfgFsZoom) / 2;
    jimpleCfgApplyTransform(true);
  });
}

function jimpleCfgFullscreen() {
  var sig = document.getElementById('jimpleCfgMethodSelect').value;
  if (!sig || !_jimpleCfgMethods[sig]) return;
  var modal = document.getElementById('jimpleCfgFsModal');
  modal.style.display = 'flex';
  document.getElementById('jimpleCfgFsTitle').textContent = sig;
  // Clone the SVG content into the fullscreen svg
  var srcRoot = document.getElementById('jimpleCfgRoot');
  var srcSvg  = document.getElementById('jimpleCfgSvg');
  var dstRoot = document.getElementById('jimpleCfgFsRoot');
  var dstSvg  = document.getElementById('jimpleCfgFsSvg');
  dstRoot.innerHTML = srcRoot.innerHTML;
  // Update marker references in cloned content to use fullscreen marker ids
  dstRoot.innerHTML = dstRoot.innerHTML
    .split('url(#cfgArrowTrue)').join('url(#cfgArrowTrueFs)')
    .split('url(#cfgArrowFalse)').join('url(#cfgArrowFalseFs)')
    .split('url(#cfgArrow)').join('url(#cfgArrowFs)');
  jimpleCfgFitFs();
  jimpleCfgSetupPanZoom(true);
}

function jimpleCfgCloseFullscreen() {
  document.getElementById('jimpleCfgFsModal').style.display = 'none';
}

// Allow Escape to close fullscreen
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') jimpleCfgCloseFullscreen();
});

function jimpleCfgSetupPanZoom(fs) {
  var vpId = fs ? 'jimpleCfgFsViewport' : 'jimpleCfgViewport';
  var vp = document.getElementById(vpId);
  if (!vp || vp._cfgBound) return;
  vp._cfgBound = true;

  vp.addEventListener('mousedown', function(e) {
    var pan = fs ? _jimpleCfgFsPan : _jimpleCfgPan;
    _jimpleCfgDrag = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, fs: !!fs };
    vp.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', function(e) {
    if (!_jimpleCfgDrag || _jimpleCfgDrag.fs !== !!fs) return;
    var pan = fs ? _jimpleCfgFsPan : _jimpleCfgPan;
    pan.x = _jimpleCfgDrag.px + (e.clientX - _jimpleCfgDrag.sx);
    pan.y = _jimpleCfgDrag.py + (e.clientY - _jimpleCfgDrag.sy);
    jimpleCfgApplyTransform(fs);
  });
  window.addEventListener('mouseup', function() {
    if (_jimpleCfgDrag && _jimpleCfgDrag.fs === !!fs) { _jimpleCfgDrag = null; vp.style.cursor = 'grab'; }
  });
  vp.addEventListener('wheel', function(e) {
    e.preventDefault();
    var factor = e.deltaY < 0 ? 1.1 : 0.9;
    if (fs) { _jimpleCfgFsZoom = Math.max(0.05, Math.min(4.0, _jimpleCfgFsZoom * factor)); jimpleCfgApplyTransform(true); }
    else    { _jimpleCfgZoom   = Math.max(0.05, Math.min(4.0, _jimpleCfgZoom   * factor)); jimpleCfgApplyTransform(); }
  }, { passive: false });
}

// ── CFG AI Chat ───────────────────────────────────────────────────────────────

var _cfgChatHistory  = [];
var _cfgChatStreaming = false;
var _cfgChatTab      = 'cfg';          // 'cfg' | 'class'
// Sets of checked keys (method sigs for cfg tab, deduplicated source keys for class tab)
var _cfgChatCheckedCfg   = {};         // { sig: true }
var _cfgChatCheckedClass = {};         // { classKey: true }  classKey = first sig sharing that source

// Derive unique class keys (one per distinct source blob)
function _cfgChatClassKeys() {
  var seen = [];   // [source string]
  var keys = [];   // [representative sig]
  Object.keys(_jimpleCfgSources).sort().forEach(function(sig) {
    var src = _jimpleCfgSources[sig];
    if (seen.indexOf(src) < 0) { seen.push(src); keys.push(sig); }
  });
  return keys;
}

// Friendly display name for a class key.
// Jimple method sigs from Soot look like: "<com.example.Foo: void method(...)>"
// __file__ClassName.jimple keys come from files with no parseable methods.
function _cfgChatClassName(sig) {
  // Files stored with __file__ prefix
  if (sig.indexOf('__file__') === 0) return sig.slice(8);
  // Soot-style "<ClassName: ...>"
  var angleStart = sig.indexOf('<');
  var colon = sig.indexOf(':');
  if (angleStart >= 0 && colon > angleStart) {
    return sig.slice(angleStart + 1, colon).trim();
  }
  // Fallback: "returnType qualifiedClass.method(args)"
  var parts = sig.split(' ');
  var qualName = parts.length >= 2 ? parts[1] : parts[0];
  var parenIdx = qualName.indexOf('(');
  if (parenIdx >= 0) qualName = qualName.slice(0, parenIdx);
  var dotIdx = qualName.lastIndexOf('.');
  return dotIdx >= 0 ? qualName.slice(0, dotIdx) : qualName;
}

function jimpleCfgOpenChat() {
  var modal = document.getElementById('jimpleCfgChatModal');
  modal.style.display = 'flex';
  // Pre-select currently viewed CFG method
  var sig = document.getElementById('jimpleCfgMethodSelect').value;
  if (sig) { _cfgChatCheckedCfg[sig] = true; }
  _jimpleCfgChatRebuildLists();
  document.getElementById('jimpleCfgChatInput').focus();
}

function jimpleCfgCloseChat() {
  document.getElementById('jimpleCfgChatModal').style.display = 'none';
}

function jimpleCfgChatSwitchTab(tab) {
  _cfgChatTab = tab;
  document.getElementById('jimpleCfgChatListCfg').style.display   = tab === 'cfg'   ? '' : 'none';
  document.getElementById('jimpleCfgChatListClass').style.display  = tab === 'class' ? '' : 'none';
  var cfgBtn   = document.getElementById('jimpleCfgChatTabCfg');
  var classBtn = document.getElementById('jimpleCfgChatTabClass');
  cfgBtn.style.borderBottomColor   = tab === 'cfg'   ? 'var(--accent-no-ads)' : 'transparent';
  cfgBtn.style.color               = tab === 'cfg'   ? 'var(--text)' : 'var(--text-muted)';
  cfgBtn.style.fontWeight          = tab === 'cfg'   ? '600' : 'normal';
  classBtn.style.borderBottomColor = tab === 'class' ? 'var(--accent-no-ads)' : 'transparent';
  classBtn.style.color             = tab === 'class' ? 'var(--text)' : 'var(--text-muted)';
  classBtn.style.fontWeight        = tab === 'class' ? '600' : 'normal';
}

function _jimpleCfgChatRebuildLists() {
  var filter = (document.getElementById('jimpleCfgChatFilter').value || '').toLowerCase();

  // ── CFG method list ──
  var cfgList = document.getElementById('jimpleCfgChatListCfg');
  cfgList.innerHTML = '';
  var cfgSigs = Object.keys(_jimpleCfgMethods).sort();
  cfgSigs.forEach(function(sig) {
    if (filter && sig.toLowerCase().indexOf(filter) < 0) return;
    var row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:7px;padding:4px 12px;cursor:pointer;font-size:.72rem;color:var(--text);';
    row.title = sig;
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.cssText = 'margin-top:2px;flex-shrink:0;accent-color:var(--accent-no-ads);';
    cb.checked = !!_cfgChatCheckedCfg[sig];
    cb.onchange = function() {
      if (cb.checked) _cfgChatCheckedCfg[sig] = true;
      else delete _cfgChatCheckedCfg[sig];
      _jimpleCfgChatUpdateCount();
    };
    var txt = document.createElement('span');
    txt.style.cssText = 'word-break:break-all;overflow-wrap:anywhere;white-space:normal;min-width:0;';
    txt.textContent = sig;
    row.appendChild(cb);
    row.appendChild(txt);
    cfgList.appendChild(row);
  });
  if (!cfgList.children.length) {
    cfgList.innerHTML = '<div style="padding:10px 12px;font-size:.72rem;color:var(--text-muted);">No CFG methods loaded yet.</div>';
  }

  // ── Class list ──
  var classList = document.getElementById('jimpleCfgChatListClass');
  classList.innerHTML = '';
  var classKeys = _cfgChatClassKeys();
  classKeys.forEach(function(key) {
    var name = _cfgChatClassName(key);
    if (filter && name.toLowerCase().indexOf(filter) < 0) return;
    var row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:7px;padding:4px 12px;cursor:pointer;font-size:.72rem;color:var(--text);';
    row.title = name;
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.cssText = 'margin-top:2px;flex-shrink:0;accent-color:var(--accent-no-ads);';
    cb.checked = !!_cfgChatCheckedClass[key];
    cb.onchange = function() {
      if (cb.checked) _cfgChatCheckedClass[key] = true;
      else delete _cfgChatCheckedClass[key];
      _jimpleCfgChatUpdateCount();
    };
    var txt = document.createElement('span');
    txt.style.cssText = 'word-break:break-all;overflow-wrap:anywhere;white-space:normal;min-width:0;';
    txt.textContent = name;
    row.appendChild(cb);
    row.appendChild(txt);
    classList.appendChild(row);
  });
  if (!classList.children.length) {
    classList.innerHTML = '<div style="padding:10px 12px;font-size:.72rem;color:var(--text-muted);">No classes loaded yet.</div>';
  }

  _jimpleCfgChatUpdateCount();
}

function _jimpleCfgChatUpdateCount() {
  var cfgN   = Object.keys(_cfgChatCheckedCfg).length;
  var classN = Object.keys(_cfgChatCheckedClass).length;
  var parts = [];
  if (cfgN)   parts.push(cfgN + ' method' + (cfgN > 1 ? 's' : ''));
  if (classN) parts.push(classN + ' class' + (classN > 1 ? 'es' : ''));
  document.getElementById('jimpleCfgChatSelCount').textContent =
    parts.length ? parts.join(' + ') + ' selected' : 'Nothing selected — chat will have no code context';
}

function jimpleCfgChatFilterList() {
  _jimpleCfgChatRebuildLists();
  // Re-apply tab visibility
  jimpleCfgChatSwitchTab(_cfgChatTab);
}

function jimpleCfgChatSelectAll(on) {
  if (_cfgChatTab === 'cfg') {
    Object.keys(_jimpleCfgMethods).forEach(function(sig) {
      if (on) _cfgChatCheckedCfg[sig] = true; else delete _cfgChatCheckedCfg[sig];
    });
  } else {
    _cfgChatClassKeys().forEach(function(key) {
      if (on) _cfgChatCheckedClass[key] = true; else delete _cfgChatCheckedClass[key];
    });
  }
  _jimpleCfgChatRebuildLists();
  jimpleCfgChatSwitchTab(_cfgChatTab);
}

function jimpleCfgChatClear() {
  _cfgChatHistory = [];
  document.getElementById('jimpleCfgChatMessages').innerHTML = '';
}

function jimpleCfgChatKeydown(ev) {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); jimpleCfgChatSend(); }
}

// Build the context block from checked selections
function _jimpleCfgChatBuildContext() {
  var parts = [];

  // CFG methods
  var cfgSigs = Object.keys(_cfgChatCheckedCfg).sort();
  cfgSigs.forEach(function(sig) {
    var blocks = _jimpleCfgMethods[sig];
    if (!blocks) return;
    var src = _jimpleCfgSources[sig] || '';
    var cfgText = blocks.map(function(b) {
      var succsStr = b.succs.map(function(s) { return s.label ? s.id + '[' + s.label + ']' : s.id; }).join(', ');
      return 'Block ' + b.id + ':\\n' + b.stmts.join('\\n') + (succsStr ? '\\n  -> ' + succsStr : '');
    }).join('\\n\\n');
    parts.push(
      '=== CFG METHOD: ' + sig + ' ===\\n' +
      (src ? '--- Jimple source ---\\n' + src + '\\n--- end source ---\\n\\n' : '') +
      '--- CFG blocks ---\\n' + cfgText + '\\n=== END METHOD ==='
    );
  });

  // Class files (deduplicated)
  var classKeys = Object.keys(_cfgChatCheckedClass).sort();
  classKeys.forEach(function(key) {
    var src = _jimpleCfgSources[key];
    if (!src) return;
    var name = _cfgChatClassName(key);
    parts.push('=== JIMPLE CLASS: ' + name + ' ===\\n' + src + '\\n=== END CLASS ===');
  });

  return parts.length ? parts.join('\\n\\n') : null;
}

async function jimpleCfgChatSend() {
  if (_cfgChatStreaming) return;
  var input = document.getElementById('jimpleCfgChatInput');
  var text = input.value.trim();
  if (!text) return;
  input.value = '';

  var contextBlock = _jimpleCfgChatBuildContext();
  var isFirst = _cfgChatHistory.length === 0;
  var userContent = text;
  if (contextBlock) {
    if (isFirst) {
      userContent = 'I have provided the following Jimple bytecode and control flow graph data for analysis. Please use it to answer my questions.\\n\\n' + contextBlock + '\\n\\nMy question: ' + text;
    } else {
      // Re-attach context on every turn so the model never loses it
      userContent = '[Context (for reference):]\\n' + contextBlock + '\\n\\n[My question:] ' + text;
    }
  }

  var systemMsg = 'You are an expert Android reverse-engineer and bytecode analyst. The user will provide Jimple IR bytecode (3-address code produced by the Soot framework from an Android APK) and control flow graph data. Help analyze the code for logic, security issues, data flow, or any other questions the user has. When referencing CFG blocks use the block ID. Format code as fenced code blocks.';

  _cfgChatHistory.push({ role: 'user', content: userContent });
  _jimpleCfgChatAppendBubble('user', text);

  _cfgChatStreaming = true;
  document.getElementById('jimpleCfgChatSendBtn').disabled = true;
  var assistantEl = _jimpleCfgChatAppendBubble('assistant', '');
  var accumulated = '';

  try {
    var resp = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: systemMsg, history: _cfgChatHistory }),
    });
    if (!resp.ok) { throw new Error(await resp.text()); }

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      var lines = buf.split('\\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line.startsWith('data: ')) continue;
        var payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try {
          var parsed = JSON.parse(payload);
          var delta = (parsed.choices[0].delta.content) || '';
          accumulated += delta;
          chatRenderBubbleContent(assistantEl, accumulated);
          var msgs = document.getElementById('jimpleCfgChatMessages');
          msgs.scrollTop = msgs.scrollHeight;
        } catch(_) {}
      }
    }
    _cfgChatHistory.push({ role: 'assistant', content: accumulated });
  } catch(e) {
    chatRenderBubbleContent(assistantEl, '*Error: ' + escHtml(String(e)) + '*');
  }

  _cfgChatStreaming = false;
  document.getElementById('jimpleCfgChatSendBtn').disabled = false;
  var msgs2 = document.getElementById('jimpleCfgChatMessages');
  msgs2.scrollTop = msgs2.scrollHeight;
}

function _jimpleCfgChatAppendBubble(role, content) {
  var msgs = document.getElementById('jimpleCfgChatMessages');
  var wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;' + (role === 'user' ? 'align-items:flex-end;' : 'align-items:flex-start;');
  var label = document.createElement('div');
  label.style.cssText = 'font-size:.68rem;color:var(--text-muted);padding:0 4px;';
  label.textContent = role === 'user' ? 'You' : 'Assistant';
  var bubble = document.createElement('div');
  bubble.style.cssText = 'max-width:86%;padding:9px 13px;border-radius:10px;font-size:.82rem;line-height:1.55;'
    + (role === 'user'
      ? 'background:var(--accent-no-ads);color:#fff;border-bottom-right-radius:3px;'
      : 'background:var(--card-bg);border:1px solid var(--card-border);color:var(--text);border-bottom-left-radius:3px;');
  if (content) chatRenderBubbleContent(bubble, content);
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
  return bubble;
}

// ── AI Chat ───────────────────────────────────────────────────────────────────

var _chatHistory   = [];   // [{role,content}]
var _chatFileText  = '';   // loaded file content (truncated)
var _chatFileName  = '';
var _chatStreaming  = false;

async function chatLoadFileList() {
  var dir = document.getElementById('chatFileDir').value.trim() || '~/MADPro_Logcat';
  try {
    var data = await api('/api/logs/list?dir=' + encodeURIComponent(dir));
    var sel = document.getElementById('chatFileSelect');
    var prev = sel.value;
    sel.innerHTML = '<option value="">— no file context —</option>';
    for (var i = 0; i < (data.files || []).length; i++) {
      var f = data.files[i];
      var opt = document.createElement('option');
      opt.value = f.path; opt.textContent = f.name;
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some(function(o) { return o.value === prev; })) sel.value = prev;
    document.getElementById('chatFileMeta').textContent =
      data.files.length ? data.files.length + ' file(s) found' : 'No files found';
  } catch(e) {
    document.getElementById('chatFileMeta').textContent = 'Error: ' + e.message;
  }
}

function chatInputKeydown(ev) {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); chatSend(); }
}

async function chatSend() {
  if (_chatStreaming) return;
  var input = document.getElementById('chatInput');
  var text = input.value.trim();
  if (!text) return;
  input.value = '';

  // Load file context on first message or when file changes
  var filePath = document.getElementById('chatFileSelect').value;
  if (filePath && filePath !== _chatFileName) {
    try {
      var d = await api('/api/chat/file?path=' + encodeURIComponent(filePath));
      _chatFileText = d.content || '';
      _chatFileName = filePath;
      document.getElementById('chatFileMeta').textContent =
        d.truncated ? 'Context: ' + d.name + ' (truncated to ' + d.chars + ' chars)' : 'Context: ' + d.name;
    } catch(e) {
      chatAppendSystem('Could not load file: ' + e.message);
    }
  }

  // Build user message — embed file context directly in first user turn so all models see it
  var isFirstMsg = _chatHistory.length === 0;
  var userContent = text;
  if (_chatFileText && isFirstMsg) {
    userContent = 'I have loaded the following file as context. Please answer my questions about it.\\n\\n--- FILE: ' + _chatFileName + ' ---\\n' + _chatFileText + '\\n--- END FILE ---\\n\\nMy question: ' + text;
  }
  var systemMsg = 'You are an Android app analysis assistant. Answer questions about the provided log file or code.';

  // Append to history (full content with context) but display only the user's question
  _chatHistory.push({ role: 'user', content: userContent });
  chatAppendBubble('user', text);

  // Stream response
  _chatStreaming = true;
  document.getElementById('chatSendBtn').disabled = true;
  var assistantEl = chatAppendBubble('assistant', '');
  var accumulated = '';

  try {
    var resp = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: systemMsg, history: _chatHistory }),
    });
    if (!resp.ok) { throw new Error(await resp.text()); }

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      // SSE: lines starting with "data: "
      var lines = buf.split('\\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line.startsWith('data: ')) continue;
        var payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try {
          var parsed = JSON.parse(payload);
          var delta = (parsed.choices[0].delta.content) || '';
          accumulated += delta;
          chatRenderBubbleContent(assistantEl, accumulated);
        } catch(_) {}
      }
    }
    _chatHistory.push({ role: 'assistant', content: accumulated });
  } catch(e) {
    chatRenderBubbleContent(assistantEl, '*Error: ' + escHtml(String(e)) + '*');
  }

  _chatStreaming = false;
  document.getElementById('chatSendBtn').disabled = false;
  chatScrollBottom();
}

function chatAppendBubble(role, content) {
  var msgs = document.getElementById('chatMessages');
  var wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;' + (role === 'user' ? 'align-items:flex-end;' : 'align-items:flex-start;');
  var label = document.createElement('div');
  label.style.cssText = 'font-size:.7rem;color:var(--text-muted);padding:0 4px;';
  label.textContent = role === 'user' ? 'You' : 'Assistant';
  var bubble = document.createElement('div');
  bubble.style.cssText = 'max-width:82%;padding:10px 14px;border-radius:10px;font-size:.84rem;line-height:1.6;'
    + (role === 'user'
      ? 'background:var(--accent-no-ads);color:#fff;border-bottom-right-radius:3px;'
      : 'background:var(--card-bg);border:1px solid var(--card-border);color:var(--text);border-bottom-left-radius:3px;');
  if (content) chatRenderBubbleContent(bubble, content);
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  msgs.appendChild(wrap);
  chatScrollBottom();
  return bubble;
}

function chatAppendSystem(text) {
  var msgs = document.getElementById('chatMessages');
  var el = document.createElement('div');
  el.style.cssText = 'font-size:.75rem;color:var(--text-muted);text-align:center;padding:4px 0;';
  el.textContent = text;
  msgs.appendChild(el);
}

function chatMakeCopyBtn(getText) {
  var btn = document.createElement('button');
  btn.textContent = 'Copy';
  btn.style.cssText = 'position:absolute;top:6px;right:6px;font-size:.65rem;padding:2px 7px;border-radius:4px;border:1px solid var(--card-border);background:var(--surface);color:var(--text-muted);cursor:pointer;opacity:.8;';
  btn.onclick = function() {
    var txt = typeof getText === 'function' ? getText() : getText;
    navigator.clipboard.writeText(txt).then(function() {
      btn.textContent = 'Copied!';
      btn.style.color = '#22c55e';
      setTimeout(function() { btn.textContent = 'Copy'; btn.style.color = ''; }, 1500);
    });
  };
  return btn;
}

// Render bubble content: detect code/mermaid fenced blocks, add copy buttons
function chatRenderBubbleContent(bubble, text) {
  var fence = '\x60\x60\x60';
  var mermaidKW = ['graph ', 'flowchart ', 'sequencediagram', 'classdiagram', 'statediagram', 'erdiagram', 'gantt', 'pie ', 'gitgraph', 'mindmap', 'timeline'];
  bubble.innerHTML = '';

  // indexOf-based fence splitter — RegExp fails with literal backtick strings in template context
  var parts = [];
  var remaining = text;
  while (remaining.length > 0) {
    var fstart = remaining.indexOf(fence);
    if (fstart === -1) { parts.push({ type: 'text', content: remaining }); break; }
    if (fstart > 0) parts.push({ type: 'text', content: remaining.slice(0, fstart) });
    remaining = remaining.slice(fstart);
    var fend = remaining.indexOf(fence, fence.length);
    if (fend === -1) { parts.push({ type: 'text', content: remaining }); break; }
    var block = remaining.slice(0, fend + fence.length);
    parts.push({ type: 'code', content: block });
    remaining = remaining.slice(fend + fence.length);
  }

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (part.type === 'text') {
      if (!part.content.trim()) continue;
      var p = document.createElement('div');
      p.style.cssText = 'white-space:pre-wrap;word-break:break-word;';
      p.innerHTML = chatSimpleMarkdown(part.content);
      bubble.appendChild(p);
    } else {
      // Strip the opening fence + optional language tag to get raw code
      var raw = part.content;
      // Remove opening fence line
      var nlPos = raw.indexOf('\\n');
      var langLine = nlPos === -1 ? raw : raw.slice(0, nlPos);
      var inner = nlPos === -1 ? '' : raw.slice(nlPos + 1);
      // Remove closing fence
      if (inner.slice(-fence.length) === fence) inner = inner.slice(0, -fence.length);
      inner = inner.trim();
      var lang = langLine.slice(fence.length).trim().toLowerCase();
      var isMermaid = lang === 'mermaid' || mermaidKW.some(function(kw) { return inner.toLowerCase().indexOf(kw) === 0; });

      var codeWrap = document.createElement('div');
      codeWrap.style.cssText = 'position:relative;margin:8px 0;';
      var pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;background:#0d1117;border:1px solid var(--card-border);border-radius:8px;padding:10px 10px 10px 10px;padding-top:34px;font-size:.75rem;overflow-x:auto;color:#e6edf3;line-height:1.6;';
      pre.textContent = inner;

      var btnBar = document.createElement('div');
      btnBar.style.cssText = 'position:absolute;top:6px;right:6px;display:flex;gap:4px;';

      var cpBtn = chatMakeCopyBtn(inner);
      cpBtn.style.cssText = 'font-size:.65rem;padding:2px 7px;border-radius:4px;border:1px solid var(--card-border);background:var(--surface);color:var(--text-muted);cursor:pointer;';
      btnBar.appendChild(cpBtn);

      if (isMermaid) {
        var vBtn = document.createElement('button');
        vBtn.textContent = 'View Diagram';
        vBtn.style.cssText = 'font-size:.65rem;padding:2px 7px;border-radius:4px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer;';
        (function(c) { vBtn.onclick = function() { chatMermaidOpen(c); }; })(inner);
        btnBar.appendChild(vBtn);
      }

      codeWrap.appendChild(pre);
      codeWrap.appendChild(btnBar);
      bubble.appendChild(codeWrap);
    }
  }
  chatScrollBottom();
}

var _mermaidReady = false;
var _mermaidQueue = [];

function chatEnsureMermaid(cb) {
  if (_mermaidReady) { cb(); return; }
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
    _mermaidReady = true;
    cb();
    return;
  }
  // Load mermaid dynamically
  if (!document.getElementById('mermaid-script')) {
    var s = document.createElement('script');
    s.id = 'mermaid-script';
    s.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
    s.onload = function() {
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
      _mermaidReady = true;
      cb();
    };
    document.head.appendChild(s);
  } else {
    // Script tag exists but not loaded yet — poll
    var t = setInterval(function() {
      if (typeof mermaid !== 'undefined') {
        clearInterval(t);
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
        _mermaidReady = true;
        cb();
      }
    }, 100);
  }
}

var MERMAID_NODE_LIMIT = 80;
function chatRenderMermaid(code, container) {
  // Count rough node count — skip render for very large graphs to avoid browser freeze
  var lineCount = code.split('\\n').length;
  if (lineCount > MERMAID_NODE_LIMIT) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:.75rem;padding:4px 0;">Diagram too large to render (' + lineCount + ' lines). Showing source:</div>'
      + '<pre style="color:var(--text-muted);font-size:.72rem;white-space:pre-wrap;margin:0;max-height:300px;overflow:auto;">' + escHtml(code) + '</pre>';
    return;
  }
  container.style.minHeight = '120px';
  container.innerHTML = '<div style="color:var(--text-muted);font-size:.72rem;padding:8px;">Rendering diagram...</div>';
  chatEnsureMermaid(function() {
    var svgId = 'mermaid-chat-' + Date.now() + '-' + Math.floor(Math.random() * 9999) + '-svg';
    var doRender = function() {
      mermaid.render(svgId, code).then(function(result) {
        container.style.minHeight = '';
        container.innerHTML = result.svg;
        var svg = container.querySelector('svg');
        if (svg) {
          svg.style.width = '100%';
          svg.style.height = 'auto';
          svg.style.minHeight = '200px';
          svg.removeAttribute('width');
          svg.removeAttribute('height');
        }
        var leftover = document.getElementById('d' + svgId);
        if (leftover) leftover.remove();
      }).catch(function() {
        container.style.minHeight = '';
        container.innerHTML = '<pre style="color:var(--text-muted);font-size:.75rem;white-space:pre-wrap;margin:0;">' + escHtml(code) + '</pre>';
        setTimeout(function() {
          var leftover = document.getElementById('d' + svgId);
          if (leftover) leftover.remove();
        }, 0);
      });
    };
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(doRender, { timeout: 2000 });
    } else {
      setTimeout(doRender, 0);
    }
  });
}

function chatSimpleMarkdown(text) {
  var t = escHtml(text);
  var boldRe = new RegExp('[*][*]([^*]+)[*][*]', 'g');
  var emRe = new RegExp('[*]([^*]+)[*]', 'g');
  var codeRe = new RegExp('\x60([^\x60]+)\x60', 'g');
  t = t.replace(boldRe, function(_, m) { return '<strong>' + m + '</strong>'; });
  t = t.replace(emRe, function(_, m) { return '<em>' + m + '</em>'; });
  t = t.replace(codeRe, function(_, m) { return '<code style="background:#0d1117;padding:1px 5px;border-radius:3px;font-family:monospace;font-size:.82em;">' + m + '</code>'; });
  return t;
}

function chatScrollBottom() {
  var msgs = document.getElementById('chatMessages');
  msgs.scrollTop = msgs.scrollHeight;
}

function chatClear() {
  _chatHistory = [];
  _chatFileText = '';
  _chatFileName = '';
  document.getElementById('chatMessages').innerHTML = '';
}

// ── Mermaid Viewer panel ──────────────────────────────────────────────────
function chatMermaidToggle() {
  var panel = document.getElementById('chatMermaidPanel');
  var visible = panel.style.display !== 'none' && panel.style.display !== '';
  panel.style.display = visible ? 'none' : 'flex';
}

function chatMermaidOpen(code) {
  var panel = document.getElementById('chatMermaidPanel');
  panel.style.display = 'flex';
  document.getElementById('chatMermaidInput').value = code;
  chatMermaidRender();
}

function chatMermaidClose() {
  document.getElementById('chatMermaidPanel').style.display = 'none';
}

var _mermaidZoomLevels = {};

function chatMermaidZoom(containerId, delta) {
  var labelId = containerId === 'chatMermaidOutput' ? 'chatMermaidZoomLabel' : 'chatMermaidOverlayZoomLabel';
  var current = _mermaidZoomLevels[containerId] || 1.0;
  var next = Math.min(5.0, Math.max(0.1, Math.round((current + delta) * 10) / 10));
  _mermaidZoomLevels[containerId] = next;
  var svg = document.querySelector('#' + containerId + ' svg');
  if (svg) {
    svg.style.transform = 'scale(' + next + ')';
    svg.style.transformOrigin = 'top left';
    // Expand container so scrollbars appear at the right size
    svg.style.display = 'block';
    svg.parentNode.style.minWidth = Math.round(svg.getBoundingClientRect().width / next * next) + 'px';
  }
  var label = document.getElementById(labelId);
  if (label) label.textContent = Math.round(next * 100) + '%';
}

function chatMermaidZoomReset(containerId, labelId) {
  _mermaidZoomLevels[containerId] = 1.0;
  var svg = document.querySelector('#' + containerId + ' svg');
  if (svg) { svg.style.transform = ''; svg.style.transformOrigin = ''; svg.style.display = ''; }
  var label = document.getElementById(labelId);
  if (label) label.textContent = '100%';
}

function chatMermaidApplyZoom(containerId) {
  var level = _mermaidZoomLevels[containerId] || 1.0;
  if (level !== 1.0) chatMermaidZoom(containerId, 0);
}

function chatMermaidFullscreen() {
  var overlay = document.getElementById('chatMermaidOverlay');
  var overlayOut = document.getElementById('chatMermaidOverlayOutput');
  var code = document.getElementById('chatMermaidInput').value.trim();
  if (!code) return;
  overlay.style.display = 'flex';
  overlayOut.innerHTML = '<span style="color:var(--text-muted);font-size:.8rem;">Rendering...</span>';
  chatEnsureMermaid(function() {
    chatMermaidDoRender(code, overlayOut, 0);
  });
}

function chatMermaidExitFullscreen(ev) {
  if (!ev || ev.target === document.getElementById('chatMermaidOverlay') || ev.type !== 'click' || !ev.currentTarget) {
    document.getElementById('chatMermaidOverlay').style.display = 'none';
    document.getElementById('chatMermaidOverlayOutput').innerHTML = '';
  }
}

function chatMermaidClear() {
  document.getElementById('chatMermaidInput').value = '';
  document.getElementById('chatMermaidOutput').innerHTML = '';
}

function chatMermaidAutoFix(code) {
  var lines = code.split('\\n');
  // Detect diagram type from first non-empty line
  var firstLine = '';
  for (var i = 0; i < lines.length; i++) { if (lines[i].trim()) { firstLine = lines[i].trim().toLowerCase(); break; } }
  var isFlow = firstLine.startsWith('graph') || firstLine.startsWith('flowchart');

  var fixed = lines.map(function(line) {
    var t = line;
    // Remove markdown bold/italic artifacts inside node labels
    t = t.replace(new RegExp('[*][*]([^*]+)[*][*]', 'g'), function(_, m) { return m; });
    t = t.replace(new RegExp('[*]([^*]+)[*]', 'g'), function(_, m) { return m; });
    // Fix common arrow typos: -> should be --> in flowcharts
    if (isFlow) {
      // single dash arrow: A -> B  =>  A --> B (but not inside labels)
      t = t.replace(/ -([^->) ]) /g, function(_, c) { return ' --' + c + ' '; });
      t = t.replace(/ ->([^>])/g, function(_, c) { return ' -->' + c; });
    }
    // Remove trailing semicolons that break some parsers
    t = t.replace(/;+$/, '');
    // Fix unquoted curly-brace node labels: B{foo bar} => B{"foo bar"} only if label has spaces
    t = t.replace(/([A-Za-z0-9_]+)\{([^}]+)\}/g, function(_, id, label) {
      if (label.indexOf(' ') !== -1 && label[0] !== '"') return id + '{"' + label + '"}';
      return id + '{' + label + '}';
    });
    // Fix unquoted square-bracket node labels with special chars (colons etc): A[foo: bar] => A["foo: bar"]
    t = t.replace(new RegExp('([A-Za-z0-9_]+)\\\\[([^\\\\]]+)\\\\]', 'g'), function(_, id, label) {
      if ((label.indexOf(':') !== -1 || label.indexOf(',') !== -1) && label[0] !== '"') return id + '["' + label + '"]';
      return id + '[' + label + ']';
    });
    // Fix smart/curly quotes to straight quotes in labels
    t = t.replace(/[\u201c\u201d]/g, '"');
    t = t.replace(/[\u2018\u2019]/g, "'");
    // Fix em-dash used as arrow: A -- B => A --> B when in flow diagrams
    if (isFlow) {
      t = t.replace(/ \u2014 /g, ' --> ');
    }
    // Strip leading/trailing whitespace-only lines bloat
    return t;
  });

  // Remove consecutive blank lines
  var out = [];
  var prevBlank = false;
  for (var j = 0; j < fixed.length; j++) {
    var blank = fixed[j].trim() === '';
    if (blank && prevBlank) continue;
    out.push(fixed[j]);
    prevBlank = blank;
  }
  return out.join('\\n');
}

function chatMermaidDoRender(code, out, attempt) {
  var svgId = 'mermaid-viewer-' + Date.now() + '-' + attempt + '-svg';
  // Reset zoom for this container before rendering
  var containerId = out.id;
  _mermaidZoomLevels[containerId] = 1.0;
  var zLabelId = containerId === 'chatMermaidOutput' ? 'chatMermaidZoomLabel' : 'chatMermaidOverlayZoomLabel';
  var zLabel = document.getElementById(zLabelId);
  if (zLabel) zLabel.textContent = '100%';

  mermaid.render(svgId, code).then(function(result) {
    out.innerHTML = result.svg;
    var svg = out.querySelector('svg');
    if (svg) {
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.style.cssText = 'width:100%;height:auto;min-height:200px;font-size:14px;display:block;transform-origin:top left;';
      svg.querySelectorAll('text, .label, .nodeLabel').forEach(function(el) {
        el.style.fontSize = '13px';
        el.style.fontFamily = 'Segoe UI, system-ui, sans-serif';
      });
      // Mouse wheel zoom
      out.onwheel = function(e) {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          chatMermaidZoom(containerId, e.deltaY < 0 ? 0.1 : -0.1);
        }
      };
    }
    var leftover = document.getElementById('d' + svgId);
    if (leftover) leftover.remove();
    if (attempt > 0) {
      // Show a notice that auto-fix was applied
      var notice = document.createElement('div');
      notice.style.cssText = 'font-size:.68rem;color:#f59e0b;margin-top:6px;';
      notice.textContent = 'Auto-fixed ' + attempt + ' issue(s) before rendering.';
      out.appendChild(notice);
      // Update the textarea with the fixed code
      document.getElementById('chatMermaidInput').value = code;
    }
  }).catch(function() {
    if (attempt === 0) {
      // First attempt failed — try auto-fix and retry once
      var fixed = chatMermaidAutoFix(code);
      if (fixed !== code) {
        chatMermaidDoRender(fixed, out, 1);
      } else {
        out.innerHTML = '<pre style="color:var(--text-muted);font-size:.75rem;white-space:pre-wrap;">' + escHtml(code) + '</pre>'
          + '<div style="color:#ef4444;font-size:.72rem;margin-top:4px;">Could not render — check Mermaid syntax.</div>';
      }
    } else {
      // Auto-fix also failed — show raw code with error
      out.innerHTML = '<pre style="color:var(--text-muted);font-size:.75rem;white-space:pre-wrap;">' + escHtml(code) + '</pre>'
        + '<div style="color:#ef4444;font-size:.72rem;margin-top:4px;">Auto-fix did not resolve the syntax error.</div>';
    }
    setTimeout(function() { var l = document.getElementById('d' + svgId); if (l) l.remove(); }, 0);
  });
}

function chatMermaidRender() {
  var code = document.getElementById('chatMermaidInput').value.trim();
  var out = document.getElementById('chatMermaidOutput');
  if (!code) { out.innerHTML = '<span style="color:var(--text-muted);font-size:.8rem;">Paste Mermaid code above and click Render.</span>'; return; }
  out.innerHTML = '<span style="color:var(--text-muted);font-size:.75rem;">Rendering...</span>';
  chatEnsureMermaid(function() {
    chatMermaidDoRender(code, out, 0);
  });
}

async function chatInitTab() {
  // Load saved model into the inline input
  try {
    var s = await api('/api/settings');
    var inp = document.getElementById('chatModelInput');
    if (!inp.value) inp.value = s.openwebui_model || '';
  } catch(_) {}
}

async function chatSaveModel(btn) {
  var model = document.getElementById('chatModelInput').value.trim();
  if (!model) return;
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openwebui_model: model })
    });
    if (btn) {
      var orig = btn.textContent;
      btn.textContent = 'Saved';
      btn.style.color = '#22c55e';
      setTimeout(function() { btn.textContent = orig; btn.style.color = ''; }, 1500);
    }
  } catch(e) { alert('Save failed: ' + e.message); }
}
</script>
</body>
</html>`;
}

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost`);
  const pathname = reqUrl.pathname;

  // GET /
  if (req.method === "GET" && pathname === "/") {
    return htmlResponse(res, renderHtml());
  }

  // GET /api/status
  if (req.method === "GET" && pathname === "/api/status") {
    return jsonResponse(res, {
      dir: state.dir,
      scanning: state.scanning,
      enriching: state.enriching,
      progress: state.progress,
      apps: state.apps,
      error: state.error,
      warning: state.warning,
    });
  }

  // POST /api/scan  body: { dir: "/path" }
  if (req.method === "POST" && pathname === "/api/scan") {
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse(res, { error: "Invalid JSON body" }, 400);
    }
    const dir = (payload.dir || "").trim();
    if (!dir) return jsonResponse(res, { error: "Missing dir" }, 400);
    if (!fs.existsSync(dir)) return jsonResponse(res, { error: "Directory not found: " + dir }, 400);

    runScan(dir).catch((err) => {
      state.error = err.message;
      state.scanning = false;
      state.enriching = false;
    });

    return jsonResponse(res, { ok: true });
  }

  // GET /api/browse-apks?dir=/path  — dirs + .apk files
  if (req.method === "GET" && pathname === "/api/browse-apks") {
    const dirParam = reqUrl.searchParams.get("dir") || os.homedir();
    const targetDir = dirParam.trim() || os.homedir();
    try {
      const abs = path.resolve(targetDir);
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => ({ name: e.name, path: path.join(abs, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const apks = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith(".apk"))
        .map(e => ({ name: e.name, path: path.join(abs, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(abs) !== abs ? path.dirname(abs) : null;
      return jsonResponse(res, { current: abs, parent, dirs, apks, home: os.homedir() });
    } catch {
      return jsonResponse(res, { current: os.homedir(), parent: null, dirs: [], apks: [], home: os.homedir() });
    }
  }

  // GET /api/logs/list?dir=/path — list .log files in a directory
  if (req.method === "GET" && pathname === "/api/logs/list") {
    const dirParam = (reqUrl.searchParams.get("dir") || "~/MADPro_Logcat").trim();
    const abs = path.resolve(dirParam.replace(/^~/, os.homedir()));
    try {
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const files = entries
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith(".log"))
        .map(e => ({ name: e.name, path: path.join(abs, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return jsonResponse(res, { dir: abs, files });
    } catch {
      return jsonResponse(res, { dir: abs, files: [] });
    }
  }

  // GET /api/logs/read?file=/path&offset=0&limit=300
  if (req.method === "GET" && pathname === "/api/logs/read") {
    const fileParam = reqUrl.searchParams.get("file") || "";
    if (!fileParam) return jsonResponse(res, { error: "Missing file" }, 400);
    const abs = path.resolve(fileParam.replace(/^~/, os.homedir()));
    const offset = Math.max(0, parseInt(reqUrl.searchParams.get("offset") || "0", 10));
    const limit  = Math.min(2000, Math.max(1, parseInt(reqUrl.searchParams.get("limit") || "300", 10)));
    try {
      const entries = parseLogEntries(abs);
      const unique = entries.filter(e => !e.duplicate).length;
      return jsonResponse(res, {
        file: abs,
        total: entries.length,
        unique,
        entries: entries.slice(offset, offset + limit),
      });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // GET /api/logs/search?file=/path&q=["keyword1(","keyword2("]
  if (req.method === "GET" && pathname === "/api/logs/search") {
    const fileParam = reqUrl.searchParams.get("file") || "";
    const qParam    = reqUrl.searchParams.get("q") || "[]";
    if (!fileParam) return jsonResponse(res, { error: "Missing file" }, 400);
    const abs = path.resolve(fileParam.replace(/^~/, os.homedir()));
    let queries;
    try { queries = JSON.parse(qParam); } catch { return jsonResponse(res, { error: "Invalid q param" }, 400); }
    if (!Array.isArray(queries)) return jsonResponse(res, { error: "q must be array" }, 400);
    try {
      const entries = parseLogEntries(abs);
      const queriesLow = queries.map(q => q.toLowerCase());

      // Per-keyword counts
      const perKeyword = queriesLow.map((ql, i) => ({
        query: queries[i],
        count: entries.filter(e => entryMatchesQuery(e, ql)).length,
      }));

      // Ordered sequence: entries that match at least one keyword
      const sequence = [];
      for (const e of entries) {
        const kwIndices = [];
        for (let i = 0; i < queriesLow.length; i++) {
          if (entryMatchesQuery(e, queriesLow[i])) kwIndices.push(i);
        }
        if (kwIndices.length > 0) sequence.push({ entry: e, kwIndices });
      }

      return jsonResponse(res, { perKeyword, sequence });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // GET /api/logs/scan-dir?dir=/path
  // Scans all .log files in dir, extracts app package names from nativeloader lines.
  // Returns { dir, packages: [{name, files:[basename,...]}] }
  if (req.method === "GET" && pathname === "/api/logs/scan-dir") {
    const dirParam = (reqUrl.searchParams.get("dir") || "~/MADPro_Logcat").trim();
    const abs = path.resolve(dirParam.replace(/^~/, os.homedir()));
    try {
      const dirents = fs.readdirSync(abs, { withFileTypes: true });
      const logFiles = dirents
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith(".log"))
        .map(e => path.join(abs, e.name));
      // Map package name → set of files it appears in
      const pkgMap = new Map(); // pkg -> Set of basenames
      for (const fp of logFiles) {
        const content = fs.readFileSync(fp, "utf8");
        const pkgs = extractAppPackages(content);
        for (const pkg of pkgs) {
          if (!pkgMap.has(pkg)) pkgMap.set(pkg, new Set());
          pkgMap.get(pkg).add(path.basename(fp));
        }
      }
      const packages = [...pkgMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, files]) => ({ name, files: [...files].sort() }));
      return jsonResponse(res, { dir: abs, totalFiles: logFiles.length, packages });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // POST /api/logs/multi-read — body: { files: ["/path/a.log", ...] }
  // Returns merged entries from all files, plus app package names from nativeloader lines.
  if (req.method === "POST" && pathname === "/api/logs/multi-read") {
    let body = "";
    await new Promise(r => { req.on("data", c => body += c); req.on("end", r); });
    let files;
    try { files = JSON.parse(body).files; } catch { return jsonResponse(res, { error: "Invalid body" }, 400); }
    if (!Array.isArray(files) || !files.length) return jsonResponse(res, { error: "files array required" }, 400);
    try {
      const allEntries = [];
      const seenGlobal = new Set();
      const appPackages = new Set();
      for (const fp of files) {
        const abs = path.resolve(fp.replace(/^~/, os.homedir()));
        const content = fs.readFileSync(abs, "utf8");
        // Extract app packages from nativeloader lines in this file
        for (const pkg of extractAppPackages(content)) appPackages.add(pkg);
        const entries = parseLogEntries(abs);
        for (const e of entries) {
          const dup = seenGlobal.has(e.key);
          allEntries.push({ ...e, duplicate: dup, sourceFile: path.basename(abs) });
          seenGlobal.add(e.key);
        }
      }
      const unique = allEntries.filter(e => !e.duplicate).length;
      return jsonResponse(res, {
        total: allEntries.length,
        unique,
        packages: [...appPackages].sort(),
        entries: allEntries,
      });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // GET /api/browse?dir=/path
  if (req.method === "GET" && pathname === "/api/browse") {
    const dirParam = reqUrl.searchParams.get("dir") || os.homedir();
    const targetDir = dirParam.trim() || os.homedir();
    try {
      const data = listDir(targetDir);
      return jsonResponse(res, data);
    } catch (err) {
      // Fallback to home if the given dir fails
      try {
        const data = listDir(os.homedir());
        return jsonResponse(res, data);
      } catch (e2) {
        return jsonResponse(res, { error: e2.message }, 500);
      }
    }
  }

  // GET /api/manifest?file=/path/to/app.apk
  if (req.method === "GET" && pathname === "/api/manifest") {
    const fileParam = reqUrl.searchParams.get("file") || "";
    if (!fileParam) return jsonResponse(res, { error: "Missing file parameter" }, 400);

    const abs = path.resolve(fileParam.replace(/^~/, os.homedir()));
    if (!fs.existsSync(abs)) return jsonResponse(res, { error: "File not found: " + abs }, 404);

    try {
      const summary = getManifestSummary(abs);
      return jsonResponse(res, summary);
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // POST /api/export  body: { dir: "/path", filename: "report.pdf" }
  if (req.method === "POST" && pathname === "/api/export") {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { return jsonResponse(res, { error: "Invalid JSON" }, 400); }

    const saveDir = (payload.dir || "").trim();
    const rawName = (payload.filename || "apk-dashboard.pdf").trim();
    const filename = rawName.endsWith(".pdf") ? rawName : rawName + ".pdf";

    if (!saveDir) return jsonResponse(res, { error: "Missing dir" }, 400);
    if (!fs.existsSync(saveDir)) {
      try { fs.mkdirSync(saveDir, { recursive: true }); } catch (e) {
        return jsonResponse(res, { error: "Cannot create directory: " + e.message }, 400);
      }
    }

    const outPath = path.join(saveDir, filename);

    try {
      const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
      const page = await browser.newPage();

      // Load the live dashboard page so the PDF reflects the current filtered view
      await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: "networkidle0", timeout: 30000 });

      // Wait for enrichment to finish (poll until status shows done)
      await page.waitForFunction(() => {
        const bar = document.getElementById("statusBar");
        return bar && (bar.classList.contains("done") || bar.classList.contains("error"));
      }, { timeout: 60000 });

      // Inject print-friendly overrides
      await page.addStyleTag({ content: `
        header .dir-row, .toolbar, .status-bar { display: none !important; }
        .modal-overlay { display: none !important; }
        body { background: #fff !important; color: #111 !important; }
        :root {
          --bg: #fff; --surface: #f4f4f8; --card-bg: #fff;
          --card-border: #d0d4e8; --text: #111; --text-muted: #555;
          --accent-ads: #c0392b; --accent-no-ads: #1e8449;
          --text-link: #1a5276; --badge-bg: #e8eaf0;
        }
        .board { padding: 16px; gap: 16px; }
        .card { break-inside: avoid; }
        .store-link { color: #1a5276; }
        @page { margin: 16mm; }
      `});

      // Add a report header
      await page.evaluate((dir, ts) => {
        const hdr = document.createElement("div");
        hdr.style.cssText = "padding:0 24px 12px;font-family:sans-serif;border-bottom:2px solid #ccc;margin-bottom:8px;";
        hdr.innerHTML = '<h2 style="margin:0 0 4px;font-size:1.2rem;">APK Kanban Report</h2>'
          + '<div style="font-size:.8rem;color:#555;">Directory: ' + dir + ' &nbsp;|&nbsp; Generated: ' + ts + '</div>';
        document.body.insertBefore(hdr, document.body.firstChild);
      }, state.dir || "", new Date().toLocaleString());

      await page.pdf({
        path: outPath,
        format: "A4",
        landscape: true,
        printBackground: true,
        margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
      });

      await browser.close();
      return jsonResponse(res, { ok: true, path: outPath });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // GET /api/tools/status — tool availability + device list
  if (req.method === "GET" && pathname === "/api/tools/status") {
    return jsonResponse(res, {
      tools: toolsApi.checkTools(),
      devices: toolsApi.listAdbDevices(),
      avds: toolsApi.listAvds(),
    });
  }

  // POST /api/tools/download  { categories, count, outputDir, backend }
  if (req.method === "POST" && pathname === "/api/tools/download") {
    const body = await readBody(req);
    let p; try { p = JSON.parse(body); } catch { return jsonResponse(res, { error: "Bad JSON" }, 400); }
    if (!p.categories?.length) return jsonResponse(res, { error: "No categories" }, 400);
    if (!p.outputDir) return jsonResponse(res, { error: "Missing outputDir" }, 400);
    const jobId = toolsApi.startDownload({ categories: p.categories, count: p.count || 10, outputDir: p.outputDir, backend: p.backend || "apkpure", deviceSerial: p.deviceSerial || null });
    return jsonResponse(res, { jobId });
  }

  // POST /api/tools/inject  { apkDir, patterns, outputDir }
  if (req.method === "POST" && pathname === "/api/tools/inject") {
    const body = await readBody(req);
    let p; try { p = JSON.parse(body); } catch { return jsonResponse(res, { error: "Bad JSON" }, 400); }
    if (!p.apkDir) return jsonResponse(res, { error: "Missing apkDir" }, 400);
    if (!p.outputDir) return jsonResponse(res, { error: "Missing outputDir" }, 400);
    const jobId = toolsApi.startInjection({ apkDir: p.apkDir, patterns: p.patterns || [], outputDir: p.outputDir });
    return jsonResponse(res, { jobId });
  }

  // POST /api/tools/compile — compile LogInjector.java on host
  if (req.method === "POST" && pathname === "/api/tools/compile") {
    const jobId = toolsApi.startCompile();
    return jsonResponse(res, { jobId });
  }

  // POST /api/tools/instrument  { apkDir, logDir, deviceSerial }
  if (req.method === "POST" && pathname === "/api/tools/instrument") {
    const body = await readBody(req);
    let p; try { p = JSON.parse(body); } catch { return jsonResponse(res, { error: "Bad JSON" }, 400); }
    if (!p.apkDir) return jsonResponse(res, { error: "Missing apkDir" }, 400);
    if (!fs.existsSync(p.apkDir)) return jsonResponse(res, { error: "Directory not found: " + p.apkDir }, 400);
    const jobId = toolsApi.startInstrumentation({ apkDir: p.apkDir, logDir: p.logDir || null, deviceSerial: p.deviceSerial || null });
    return jsonResponse(res, { jobId });
  }

  // POST /api/tools/cancel  { jobId }
  if (req.method === "POST" && pathname === "/api/tools/cancel") {
    const body = await readBody(req);
    let p; try { p = JSON.parse(body); } catch { return jsonResponse(res, { error: "Bad JSON" }, 400); }
    toolsApi.cancelJob(p.jobId);
    return jsonResponse(res, { ok: true });
  }

  // GET /api/tools/stream/:jobId  — Server-Sent Events log stream
  if (req.method === "GET" && pathname.startsWith("/api/tools/stream/")) {
    const jobId = pathname.split("/").pop();
    const job = toolsApi.getJob(jobId);
    if (!job) { res.writeHead(404); return res.end("Job not found"); }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Replay existing lines
    for (const line of job.lines) {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    }
    if (job.done) {
      res.write(`data: ${JSON.stringify({ __done: true, error: job.error })}\n\n`);
      return res.end();
    }
    job.clients.push(res);
    req.on("close", () => {
      job.clients = job.clients.filter(c => c !== res);
    });
    return;
  }

  // GET /api/settings
  if (req.method === "GET" && pathname === "/api/settings") {
    const s = loadSettings();
    // Never send the raw key to the browser — send a masked version
    return jsonResponse(res, { ...s, openwebui_key: s.openwebui_key ? "••••••••" : "" });
  }

  // POST /api/settings
  if (req.method === "POST" && pathname === "/api/settings") {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { return jsonResponse(res, { error: "Invalid JSON" }, 400); }
    // Don't overwrite the key if the browser sent back the masked placeholder
    if (payload.openwebui_key === "••••••••") delete payload.openwebui_key;
    const saved = saveSettings(payload);
    return jsonResponse(res, { ok: true, openwebui_model: saved.openwebui_model, openwebui_url: saved.openwebui_url });
  }

  // GET /api/settings/models?url=...&key=...  — proxy model list from OpenWebUI
  if (req.method === "GET" && pathname === "/api/settings/models") {
    const owUrl = (reqUrl.searchParams.get("url") || "http://localhost:3000").replace(/\/$/, "");
    const owKey = reqUrl.searchParams.get("key") || loadSettings().openwebui_key || "";
    try {
      const r = await fetch(owUrl + "/api/models", {
        headers: owKey ? { "Authorization": "Bearer " + owKey } : {},
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      // OpenWebUI returns { data: [{id, name, ...}] } (OpenAI format)
      const models = (data.data || data.models || []).map(m => ({ id: m.id, name: m.name || m.id }));
      return jsonResponse(res, { models });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 502);
    }
  }

  // GET /api/model-image — serve model.png from project root
  if (req.method === "GET" && pathname === "/api/model-image") {
    const modelPath = path.resolve(__dirname, "..", "model.png");
    try {
      const img = fs.readFileSync(modelPath);
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
      return res.end(img);
    } catch {
      res.writeHead(404);
      return res.end("model.png not found");
    }
  }

  // POST /api/fsm/generate-contract — use AI to generate Solidity FSM smart contract
  if (req.method === "POST" && pathname === "/api/fsm/generate-contract") {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { return jsonResponse(res, { error: "Invalid JSON" }, 400); }

    const { keywords = [], logFile, logSummary = [] } = payload;

    // Build log context: either from logSummary passed by client, or read from logFile
    let methodList = logSummary;
    if (!methodList.length && logFile) {
      try {
        const absLog = path.resolve(logFile.replace(/^~/, os.homedir()));
        const entries = parseLogEntries(absLog);
        const unique = entries.filter(e => !e.duplicate).slice(0, 200);
        methodList = unique.map(e =>
          e.className ? `${e.className}#${e.methodName}(${e.args})` : e.sig
        );
      } catch (err) {
        return jsonResponse(res, { error: "Log read failed: " + err.message }, 500);
      }
    }

    const settings = loadSettings();
    const owUrl   = (settings.openwebui_url || "http://localhost:3000").replace(/\/$/, "");
    const owKey   = settings.openwebui_key  || "";
    const owModel = settings.openwebui_model || "";
    if (!owModel) return jsonResponse(res, { error: "No model configured — set one in Settings." }, 400);

    const kwBlock = keywords.length
      ? "Keywords of interest (method names):\n" + keywords.map(k => "  - " + k).join("\n")
      : "";
    const methodBlock = methodList.length
      ? "Observed method calls (up to 200 unique):\n" + methodList.slice(0, 200).map(m => "  " + m).join("\n")
      : "(No method list provided)";

    const prompt = `You are an expert Solidity developer. Generate a Solidity ^0.8.0 smart contract that models a Finite State Machine (FSM) violation auditor for an Android application, based on the observed method calls and keywords provided below.

The contract MUST follow this exact structure and pattern (adapt states, methods, and logic to match the provided data):

\`\`\`
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract FSMViolationAuditor {
    // FSM States derived from the observed lifecycle
    enum FsmState { START, STATE_1, STATE_2, ... }

    struct AppStatus {
        FsmState currentState;
        bool hasViolation;
        string[] methodHistory;
    }

    mapping(string => AppStatus) private appRegistry;
    string[] public appNames;
    mapping(string => bool) private appExists;

    event ViolationDetected(string packageName, string method, string expectedState);

    function recordTransition(string memory _pkg, string memory _method) public {
        if (!appExists[_pkg]) {
            appNames.push(_pkg);
            appExists[_pkg] = true;
            appRegistry[_pkg].currentState = FsmState.START;
        }
        AppStatus storage app = appRegistry[_pkg];
        app.methodHistory.push(_method);
        bool valid = validate(_pkg, _method);
        if (!valid) {
            app.hasViolation = true;
            emit ViolationDetected(_pkg, _method, "Sequence Break");
        }
    }

    function validate(string memory _pkg, string memory _method) internal returns (bool) {
        FsmState current = appRegistry[_pkg].currentState;
        bytes32 m = keccak256(abi.encodePacked(_method));

        // Each transition: if method hash matches AND current state is valid, advance state and return true
        if (m == keccak256("methodA")) {
            if (current == FsmState.START || current == FsmState.STATE_1) {
                appRegistry[_pkg].currentState = FsmState.STATE_1;
                return true;
            }
        }
        // ... add one block per method/transition ...

        return false; // Any other transition is a violation
    }

    function getViolationStatus(string memory _pkg) public view returns (bool) {
        return appRegistry[_pkg].hasViolation;
    }

    function getAllApps() public view returns (string[] memory) {
        return appNames;
    }

    function getAppMethods(string memory _pkg) public view returns (string[] memory) {
        return appRegistry[_pkg].methodHistory;
    }
}
\`\`\`

Rules you MUST follow:
- Name the contract FSMViolationAuditor.
- Derive the FsmState enum values from the observed methods: START is always first; each subsequent state name should reflect the lifecycle stage triggered by the corresponding method.
- Each keyword/method of interest gets its own if/else-if block in validate(), using keccak256 hash comparison.
- The validate() function uses the pattern: check method hash → check current state is a valid predecessor → advance state → return true; otherwise fall through to return false.
- Use ONLY the methods listed in the keywords and observed calls; do not invent extra methods.
- Preserve all four public/view functions: recordTransition, getViolationStatus, getAllApps, getAppMethods.
- No constructor needed unless required for initialization.

${kwBlock}

${methodBlock}

IMPORTANT: The contract will be compiled with solc targeting the London EVM. Do NOT use any features introduced after London (no PUSH0, no transient storage, no mcopy). Use \`pragma solidity ^0.8.0;\` exactly.

Return ONLY the Solidity source code. No markdown, no code fences, no explanation. Start directly with // SPDX-License-Identifier: MIT`;

    try {
      const owRes = await fetch(owUrl + "/api/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(owKey ? { "Authorization": "Bearer " + owKey } : {}),
        },
        body: JSON.stringify({
          model: owModel,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!owRes.ok) {
        const errText = await owRes.text();
        return jsonResponse(res, { error: "AI error " + owRes.status + ": " + errText.slice(0, 300) }, 502);
      }
      const owData = await owRes.json();
      let source = (owData.choices[0].message.content || "").trim();
      // Strip markdown code fences if present
      source = source.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
      return jsonResponse(res, { source });
    } catch (err) {
      return jsonResponse(res, { error: "Generation failed: " + err.message }, 500);
    }
  }

  // GET /api/eth/accounts?url=... — list Ganache accounts via eth_accounts JSON-RPC
  if (req.method === "GET" && pathname === "/api/eth/accounts") {
    const ganacheUrl = reqUrl.searchParams.get("url") || "http://127.0.0.1:7545";
    try {
      const rpcRes = await fetch(ganacheUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_accounts", params: [], id: 1 }),
      });
      const rpcData = await rpcRes.json();
      if (rpcData.error) return jsonResponse(res, { error: rpcData.error.message }, 502);
      return jsonResponse(res, { accounts: rpcData.result || [] });
    } catch (err) {
      return jsonResponse(res, { error: "Cannot reach Ganache at " + ganacheUrl + ": " + err.message }, 502);
    }
  }

  // POST /api/eth/push-data — call recordTransition(pkg, method) for each log entry
  if (req.method === "POST" && pathname === "/api/eth/push-data") {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { return jsonResponse(res, { error: "Invalid JSON" }, 400); }

    const { contractAddress, from, ganacheUrl = "http://127.0.0.1:7545", calls = [] } = payload;
    if (!contractAddress) return jsonResponse(res, { error: "Missing contractAddress" }, 400);
    if (!from)            return jsonResponse(res, { error: "Missing from address" }, 400);
    if (!calls.length)    return jsonResponse(res, { error: "No calls provided" }, 400);

    // ABI-encode recordTransition(string,string) without any external library.
    // Uses js-sha3 (bundled with solc) for keccak256.
    const sha3 = require("js-sha3");
    const SELECTOR = Buffer.from(sha3.keccak256("recordTransition(string,string)"), "hex").slice(0, 4);

    function encodeRecordTransition(pkg, method) {
      function encodeString(s) {
        const strBuf = Buffer.from(s, "utf8");
        const lenSlot = Buffer.alloc(32);
        lenSlot.writeBigUInt64BE(BigInt(strBuf.length), 24);
        const dataPad = Buffer.alloc(Math.ceil(strBuf.length / 32) * 32);
        strBuf.copy(dataPad);
        return Buffer.concat([lenSlot, dataPad]);
      }
      const enc1 = encodeString(pkg);
      const enc2 = encodeString(method);
      // offset1 = 64 (two 32-byte offsets before data), offset2 = 64 + enc1.length
      const off1 = Buffer.alloc(32); off1.writeBigUInt64BE(64n, 24);
      const off2 = Buffer.alloc(32); off2.writeBigUInt64BE(BigInt(64 + enc1.length), 24);
      return "0x" + Buffer.concat([SELECTOR, off1, off2, enc1, enc2]).toString("hex");
    }

    // Fetch current nonce once, increment locally per tx
    let nonceHex, gasPrice;
    try {
      const [nr, gr] = await Promise.all([
        fetch(ganacheUrl, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [from, "pending"], id: 1 }) }),
        fetch(ganacheUrl, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_gasPrice", params: [], id: 2 }) }),
      ]);
      const nd = await nr.json(); const gd = await gr.json();
      if (nd.error) throw new Error(nd.error.message);
      nonceHex = nd.result;
      gasPrice = gd.result;
    } catch (err) {
      return jsonResponse(res, { error: "Failed to get nonce/gasPrice: " + err.message }, 502);
    }

    let nonce = parseInt(nonceHex, 16);
    const results = [];

    for (const { pkg, method } of calls) {
      const calldata = encodeRecordTransition(String(pkg), String(method));
      const nonceStr = "0x" + nonce.toString(16);
      try {
        const txRes = await fetch(ganacheUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", method: "eth_sendTransaction",
            // 0x7A120 = 500,000 gas — enough for string storage + array push on new packages
            params: [{ from, to: contractAddress, gas: "0x7A120", gasPrice, nonce: nonceStr, data: calldata }],
            id: 10 + nonce,
          }),
        });
        const txData = await txRes.json();
        if (txData.error) {
          // Even on EVM revert / out-of-gas Ganache mines the tx and increments the nonce.
          // Re-fetch the real nonce so subsequent txs stay in sync.
          try {
            const nr = await fetch(ganacheUrl, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [from, "pending"], id: 99 }) });
            const nd = await nr.json();
            if (nd.result) nonce = parseInt(nd.result, 16);
          } catch { nonce++; } // fallback: just increment
          results.push({ pkg, method, error: txData.error.message });
        } else {
          nonce++;
          results.push({ pkg, method, txHash: txData.result });
        }
      } catch (err) {
        results.push({ pkg, method, error: err.message });
      }
    }

    return jsonResponse(res, { results });
  }

  // POST /api/eth/deploy — compile Solidity with solc and deploy to Ganache
  if (req.method === "POST" && pathname === "/api/eth/deploy") {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { return jsonResponse(res, { error: "Invalid JSON" }, 400); }

    const { source, from, ganacheUrl = "http://127.0.0.1:7545" } = payload;
    if (!source) return jsonResponse(res, { error: "Missing source" }, 400);
    if (!from)   return jsonResponse(res, { error: "Missing from address" }, 400);

    // Compile with solc
    let bytecode;
    try {
      const solc = require("solc");
      const input = {
        language: "Solidity",
        sources: { "FSMContract.sol": { content: source } },
        settings: { evmVersion: "london", outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } },
      };
      const output = JSON.parse(solc.compile(JSON.stringify(input)));
      if (output.errors) {
        const fatal = output.errors.filter(e => e.severity === "error");
        if (fatal.length) {
          return jsonResponse(res, { error: "Compilation error: " + fatal[0].formattedMessage }, 400);
        }
      }
      // Find the first contract
      const contracts = output.contracts["FSMContract.sol"];
      const contractName = Object.keys(contracts)[0];
      if (!contractName) return jsonResponse(res, { error: "No contract found in compiled output" }, 400);
      bytecode = contracts[contractName].evm.bytecode.object;
      if (!bytecode) return jsonResponse(res, { error: "Empty bytecode — check contract" }, 400);
    } catch (err) {
      return jsonResponse(res, { error: "Compile failed: " + err.message }, 500);
    }

    // Get nonce and gas price from Ganache
    let nonce, gasPrice;
    try {
      const [nonceRes, gpRes] = await Promise.all([
        fetch(ganacheUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [from, "latest"], id: 2 }),
        }),
        fetch(ganacheUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_gasPrice", params: [], id: 3 }),
        }),
      ]);
      const nonceData = await nonceRes.json();
      const gpData = await gpRes.json();
      nonce = nonceData.result;
      gasPrice = gpData.result;
    } catch (err) {
      return jsonResponse(res, { error: "Failed to get nonce/gasPrice: " + err.message }, 502);
    }

    // Send deployment transaction using Ganache's unlocked account (eth_sendTransaction)
    let txHash;
    try {
      const txRes = await fetch(ganacheUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "eth_sendTransaction",
          params: [{ from, gas: "0x4C4B40", gasPrice, nonce, data: "0x" + bytecode }],
          id: 4,
        }),
      });
      const txData = await txRes.json();
      if (txData.error) return jsonResponse(res, { error: "Transaction error: " + txData.error.message }, 502);
      txHash = txData.result;
    } catch (err) {
      return jsonResponse(res, { error: "Deploy transaction failed: " + err.message }, 502);
    }

    // Poll for receipt (up to 30s)
    let contractAddress = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const rcptRes = await fetch(ganacheUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionReceipt", params: [txHash], id: 5 }),
        });
        const rcptData = await rcptRes.json();
        if (rcptData.result && rcptData.result.contractAddress) {
          contractAddress = rcptData.result.contractAddress;
          break;
        }
      } catch { /* keep polling */ }
    }

    if (!contractAddress) return jsonResponse(res, { error: "Timed out waiting for deployment receipt. Tx: " + txHash }, 504);
    return jsonResponse(res, { contractAddress, txHash });
  }

  // POST /api/fsm/analyze — extract FSM from image via Claude, scan log for violations
  if (req.method === "POST" && pathname === "/api/fsm/analyze") {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { return jsonResponse(res, { error: "Invalid JSON" }, 400); }

    const { imageBase64, imageMime, logFile } = payload;
    if (!imageBase64) return jsonResponse(res, { error: "Missing imageBase64" }, 400);
    if (!logFile)     return jsonResponse(res, { error: "Missing logFile" }, 400);

    const absLog = path.resolve(logFile.replace(/^~/, os.homedir()));

    // 1. Extract FSM transitions from image via OpenWebUI vision API
    let transitions;
    try {
      const settings = loadSettings();
      const owUrl   = (settings.openwebui_url || "http://localhost:3000").replace(/\/$/, "");
      const owKey   = settings.openwebui_key  || "";
      const owModel = settings.openwebui_model || "";
      if (!owModel) throw new Error("No model configured — set one in Settings.");

      const prompt = "This is a Finite State Machine (FSM) diagram for an Android app lifecycle.\n"
        + "Extract every state transition. For each transition identify:\n"
        + "- from: the source state name (short identifier, no spaces)\n"
        + "- to: the destination state name\n"
        + "- method: the method name that triggers the transition (name only, no parentheses)\n\n"
        + "Return ONLY a JSON object, no markdown, no code fences:\n"
        + '{"transitions":[{"from":"StateName","to":"StateName","method":"methodName"}]}\n\n'
        + "If a transition has no label, omit it. Include self-loops (state transitions to itself).";

      const owRes = await fetch(owUrl + "/api/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(owKey ? { "Authorization": "Bearer " + owKey } : {}),
        },
        body: JSON.stringify({
          model: owModel,
          max_tokens: 2048,
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:" + (imageMime || "image/png") + ";base64," + imageBase64 } },
              { type: "text", text: prompt },
            ],
          }],
        }),
      });
      if (!owRes.ok) {
        const errText = await owRes.text();
        throw new Error("OpenWebUI error " + owRes.status + ": " + errText.slice(0, 200));
      }
      const owData = await owRes.json();
      const raw = (owData.choices[0].message.content || "").trim();
      const jsonStr = raw.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
      const parsed = JSON.parse(jsonStr);
      transitions = parsed.transitions || [];
    } catch (err) {
      return jsonResponse(res, { error: "AI extraction failed: " + err.message }, 500);
    }

    if (!transitions.length) {
      return jsonResponse(res, { error: "No transitions extracted from image" }, 422);
    }

    // 2. Parse log file
    let entries;
    try { entries = parseLogEntries(absLog); }
    catch (err) { return jsonResponse(res, { error: "Log read failed: " + err.message }, 500); }

    // 3. Match each transition's method against log entries (case-insensitive, methodName+( partial)
    const queriesLow = transitions.map(t => (t.method + "(").toLowerCase());

    const perKeyword = queriesLow.map((ql, i) => ({
      query: transitions[i].method + "(",
      count: entries.filter(e => entryMatchesQuery(e, ql)).length,
    }));

    // 4. Build ordered sequence of matching entries
    const sequence = [];
    for (const e of entries) {
      const kwIndices = [];
      for (let i = 0; i < queriesLow.length; i++) {
        if (entryMatchesQuery(e, queriesLow[i])) kwIndices.push(i);
      }
      if (kwIndices.length > 0) sequence.push({ entry: e, kwIndices, violation: false });
    }

    // 5. Detect violations: a method appears when it shouldn't given observed prior states.
    //    Simple rule: if a transition T requires being in state S, but the last observed
    //    state-entering method doesn't correspond to any transition leading to S, flag it.
    //    We do a lightweight check: find methods that appear *before* any of their
    //    prerequisite transitions have been observed.
    const violations = [];
    const observedMethods = new Set();
    for (let si = 0; si < sequence.length; si++) {
      const row = sequence[si];
      for (const kwIdx of row.kwIndices) {
        const t = transitions[kwIdx];
        // Check if the "from" state is reachable: at least one transition leading INTO t.from
        // must have been observed already (unless t.from is a start/initial state)
        const prereqs = transitions.filter(p => p.to === t.from);
        const isInitial = prereqs.length === 0 || t.from === "[*]" || t.from.toLowerCase().includes("start");
        if (!isInitial && prereqs.length > 0) {
          const prereqSatisfied = prereqs.some(p => observedMethods.has(p.method.toLowerCase()));
          if (!prereqSatisfied) {
            row.violation = true;
            violations.push({
              type: "Out-of-order",
              detail: t.method + "() called before reaching state '" + t.from + "' (expected: " +
                prereqs.map(p => p.method + "()").join(" or ") + " first)",
            });
          }
        }
        observedMethods.add(t.method.toLowerCase());
      }
    }

    return jsonResponse(res, {
      transitions,
      perKeyword,
      sequence,
      violations,
      totalEntries: entries.length,
    });
  }

  // GET /api/chat/file?path=/abs/path — read a file for chat context (truncated)
  if (req.method === "GET" && pathname === "/api/chat/file") {
    const fileParam = reqUrl.searchParams.get("path") || "";
    if (!fileParam) return jsonResponse(res, { error: "Missing path" }, 400);
    const abs = path.resolve(fileParam.replace(/^~/, os.homedir()));
    try {
      const MAX_CHARS = 40000;
      const raw = fs.readFileSync(abs, "utf8");
      const truncated = raw.length > MAX_CHARS;
      return jsonResponse(res, {
        name: path.basename(abs),
        content: raw.slice(0, MAX_CHARS),
        chars: Math.min(raw.length, MAX_CHARS),
        truncated,
      });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // POST /api/chat/stream — streaming chat via OpenWebUI
  if (req.method === "POST" && pathname === "/api/chat/stream") {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { return jsonResponse(res, { error: "Invalid JSON" }, 400); }

    const { system, history, model: modelOverride } = payload;
    const settings = loadSettings();
    const owUrl   = (settings.openwebui_url || "http://localhost:3000").replace(/\/$/, "");
    const owKey   = settings.openwebui_key  || "";
    const owModel = modelOverride || settings.openwebui_model || "";
    if (!owModel) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("No model configured — type one in the Model field or set one in Settings.");
    }

    const messages = [];
    const histArr = history || [];
    if (system) messages.push({ role: "system", content: system });
    for (const m of histArr) messages.push({ role: m.role, content: m.content });

    try {
      const owRes = await fetch(owUrl + "/api/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(owKey ? { "Authorization": "Bearer " + owKey } : {}),
        },
        body: JSON.stringify({ model: owModel, messages, stream: true }),
      });

      if (!owRes.ok) {
        const errText = await owRes.text();
        res.writeHead(502, { "Content-Type": "text/plain" });
        return res.end("OpenWebUI error " + owRes.status + ": " + errText.slice(0, 300));
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      // Pipe the SSE stream from OpenWebUI directly to the client
      const reader = owRes.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          res.write(value);
        }
      };
      req.on("close", () => reader.cancel());
      pump().catch(() => res.end());
    } catch (err) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Connection failed: " + err.message);
    }
    return;
  }

  // ── Soot / Jimple routes ───────────────────────────────────────────────────

  // POST /api/soot/run — run Soot on APK → Jimple (SSE stream)
  if (req.method === "POST" && pathname === "/api/soot/run") {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      try {
        const { apkPath, outputDir, androidJarsPath } = JSON.parse(body || "{}");
        const expandHome = p => p ? p.replace(/^~(?=\/|$)/, os.homedir()) : p;
        const resolvedApk = apkPath ? path.resolve(expandHome(apkPath)) : null;
        const resolvedOut = outputDir
          ? path.resolve(expandHome(outputDir))
          : path.join(os.homedir(), "sootOutput");
        const resolvedJars = androidJarsPath
          ? path.resolve(expandHome(androidJarsPath))
          : path.join(os.homedir(), "Android", "Sdk", "platforms");

        if (!resolvedApk || !fs.existsSync(resolvedApk)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "APK not found: " + resolvedApk }));
        }

        fs.mkdirSync(resolvedOut, { recursive: true });

        const sootJarDir = path.join(__dirname, "..", "jar_libs");
        const sootJar    = path.join(sootJarDir, "soot-4.4.0-20220321.130129-1-jar-with-dependencies.jar");
        if (!fs.existsSync(sootJar)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Soot jar not found: " + sootJar }));
        }
        const helperJars = fs.readdirSync(sootJarDir)
          .filter(f => f.endsWith(".jar") && !f.startsWith("soot-4.4.0"))
          .map(f => path.join(sootJarDir, f));
        const classpath = [sootJar, ...helperJars].join(":");

        const javaArgs = [
          "-cp", classpath,
          "soot.Main",
          "-src-prec", "apk",
          "-process-dir", resolvedApk,
          "-d", resolvedOut,
          "-output-format", "J",
          "-allow-phantom-refs",
          "-whole-program",
          "-p", "cg", "enabled:false",
          "-process-multiple-dex",
        ];
        if (fs.existsSync(resolvedJars)) {
          javaArgs.splice(javaArgs.indexOf("-d"), 0, "-android-jars", resolvedJars);
        }

        res.writeHead(200, {
          "Content-Type":  "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection":    "keep-alive",
        });
        const sse = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
        sse("log", { message: "Starting Soot…" });
        sse("log", { message: "APK: " + resolvedApk });
        sse("log", { message: "Output: " + resolvedOut });

        const child = spawn("java", javaArgs, { cwd: __dirname });
        child.stdout.on("data", d => d.toString().split("\n").filter(l => l.trim()).forEach(l => sse("log", { message: l })));
        child.stderr.on("data", d => d.toString().split("\n").filter(l => l.trim()).forEach(l => sse("log", { message: l })));
        child.on("close", code => {
          if (code === 0) {
            sse("log", { message: "" });
            sse("log", { message: "Done. Output: " + resolvedOut });
          } else {
            sse("error", { message: "Soot exited with code " + code });
          }
          sse("done", {});
          res.end();
        });
        req.on("close", () => { try { child.kill(); } catch {} });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/soot/list-jimple — list .jimple files in a folder
  if (req.method === "POST" && pathname === "/api/soot/list-jimple") {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      try {
        const { folderPath } = JSON.parse(body || "{}");
        const resolved = path.resolve(folderPath.replace(/^~(?=\/|$)/, os.homedir()));
        if (!fs.existsSync(resolved)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Folder not found: " + resolved }));
        }
        const files = [];
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".jimple")) {
              // name = relative path from root folder so user can tell packages apart
              files.push({ name: path.relative(resolved, full), path: full });
            }
          }
        };
        walk(resolved);
        files.sort((a, b) => a.name.localeCompare(b.name));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ files }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/soot/read-jimple — read a single .jimple file
  if (req.method === "POST" && pathname === "/api/soot/read-jimple") {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      try {
        const { folderPath, className } = JSON.parse(body || "{}");
        const resolved = path.resolve(folderPath.replace(/^~(?=\/|$)/, os.homedir()));
        // className may be a relative path like com/example/Foo.jimple
        const filePath = path.join(resolved, className.endsWith(".jimple") ? className : className + ".jimple");
        if (!filePath.startsWith(resolved)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Invalid path" }));
        }
        if (!fs.existsSync(filePath)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "File not found: " + filePath }));
        }
        const content = fs.readFileSync(filePath, "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`APK Dashboard running at http://localhost:${PORT}`);
  console.log(`Usage: node server.js --dir /path/to/apks --port ${PORT}`);

  if (APK_DIR) {
    runScan(APK_DIR).catch((err) => {
      state.error = err.message;
      state.scanning = false;
      state.enriching = false;
    });
  }
});
