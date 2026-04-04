/**
 * server.js — APK Kanban Dashboard
 * Run: node server.js [--dir /path/to/apks] [--port 3456]
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { scanApks } = require("./scanner");
const { lookupPlayStore, clearCache } = require("./playstore");
const { inspectApk } = require("./apk_inspector");
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
  <button class="tab-btn" id="tabBtnLogs" onclick="switchTab('logs')">🔍 Log Viewer</button>
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

<!-- ── Log Viewer tab content ── -->
<div id="tabLogs" style="display:none; padding:20px 24px;">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
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
  <div style="font-size:.8rem;color:var(--text-muted);margin-bottom:8px;" id="logViewerMeta"></div>
  <div id="logViewerOutput" style="
    background:var(--card-bg); border:1px solid var(--card-border); border-radius:8px;
    padding:14px 16px; font-family:monospace; font-size:.78rem; line-height:1.6;
    white-space:pre-wrap; word-break:break-all; max-height:65vh; overflow-y:auto;
    color:var(--text);
  ">Select a log directory and file above.</div>
</div><!-- /tabLogs -->

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
  try {
    await api('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    pollStatus();
  } catch (err) {
    document.getElementById('statusText').textContent = 'Error: ' + err.message;
    document.getElementById('statusBar').className = 'status-bar error';
    document.getElementById('btnScan').disabled = false;
  }
}

// ── Poll ────────────────────────────────────────────────────────────────────

function pollStatus() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(fetchStatus, 800);
}

async function fetchStatus() {
  const s = await api('/api/status');
  allApps = s.apps || [];
  renderBoard();
  updateStatusBar(s);
  if (s.scanning || s.enriching) {
    pollStatus();
  } else {
    document.getElementById('btnScan').disabled = false;
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
    txt.textContent = 'Scanning APK files…';
    return;
  }
  if (s.enriching) {
    bar.classList.add('enriching');
    txt.textContent = 'Fetching Play Store data: ' + s.progress.done + ' / ' + s.progress.total + '…';
    return;
  }
  bar.classList.add('done');
  txt.textContent = s.dir
    ? 'Scan complete — ' + allApps.length + ' app(s) found in ' + s.dir
    : 'Select a directory and click Scan.';
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
  document.getElementById('tabKanban').style.display = name === 'kanban' ? '' : 'none';
  document.getElementById('tabTools').style.display  = name === 'tools'  ? '' : 'none';
  document.getElementById('tabLogs').style.display   = name === 'logs'   ? '' : 'none';
  document.getElementById('tabBtnKanban').classList.toggle('active', name === 'kanban');
  document.getElementById('tabBtnTools').classList.toggle('active', name === 'tools');
  document.getElementById('tabBtnLogs').classList.toggle('active', name === 'logs');
  if (name === 'tools') initToolsTab();
  if (name === 'logs') initLogsTab();
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

async function loadLogFile() {
  const file = document.getElementById('logFileSelect').value;
  if (!file) return;
  try {
    const data = await api('/api/logs/read?file=' + encodeURIComponent(file));
    const out = document.getElementById('logViewerOutput');
    if (!data.entries || !data.entries.length) {
      out.textContent = '(No SootInjection lines found in this log file)';
      document.getElementById('logViewerMeta').textContent = '0 matches in ' + file;
      return;
    }
    out.innerHTML = '';
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
    const unique = data.entries.filter(e => !e.duplicate).length;
    document.getElementById('logViewerMeta').textContent =
      data.entries.length + ' call(s), ' + unique + ' unique methods — ' + file;
    out.scrollTop = 0;
  } catch (e) {
    document.getElementById('logViewerOutput').textContent = 'Error loading file: ' + e.message;
  }
}

function clearLogViewer() {
  document.getElementById('logViewerOutput').textContent = 'Select a log directory and file above.';
  document.getElementById('logViewerMeta').textContent = '';
  document.getElementById('logFileSelect').innerHTML = '<option value="">— select a log file —</option>';
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

  // GET /api/logs/read?file=/path — return parsed SootInjection entries from a log file
  if (req.method === "GET" && pathname === "/api/logs/read") {
    const fileParam = reqUrl.searchParams.get("file") || "";
    if (!fileParam) return jsonResponse(res, { error: "Missing file" }, 400);
    const abs = path.resolve(fileParam.replace(/^~/, os.homedir()));
    try {
      const content = fs.readFileSync(abs, "utf8");
      // Each injected line looks like:
      //   04-04 15:51:45.020 D/SootInjection(12273): Entering method: <com.example.Foo: void bar(int)>
      const MARKER = "Entering method: ";
      // Soot sig: <com.example.ClassName: returnType methodName(args)>
      // methodName may contain < > e.g. <init>, <clinit>
      const SIG_RE = /^<(.+):\s+(\S+)\s+([^(]+)\(([^)]*)\)>$/;
      const entries = [];
      const seen = new Set();
      for (const line of content.split("\n")) {
        const idx = line.indexOf(MARKER);
        if (idx === -1) continue;
        const sig = line.slice(idx + MARKER.length).trim();
        const m = SIG_RE.exec(sig);
        if (m) {
          const className = m[1].trim();
          const returnType = m[2].trim();
          const methodName = m[3].trim();
          const args = m[4].trim();
          const key = className + "#" + methodName + "(" + args + ")";
          entries.push({ className, returnType, methodName, args, sig, key, duplicate: seen.has(key) });
          seen.add(key);
        } else {
          // Fallback: couldn't parse sig, show raw
          entries.push({ className: null, returnType: null, methodName: null, args: null, sig, key: sig, duplicate: false });
        }
      }
      return jsonResponse(res, { file: abs, entries });
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
