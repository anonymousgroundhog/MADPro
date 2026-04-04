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
<title>APK Kanban Dashboard</title>
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
  <h1>APK <span>Kanban</span> Dashboard</h1>
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
