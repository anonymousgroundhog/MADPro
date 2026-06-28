/**
 * playstore.js
 * Fetches app metadata from Google Play Store using web scraping.
 * Fields retrieved: appName, rating, downloads, hasAds, storeUrl, stillOnStore.
 */

const https = require("https");

const CACHE = new Map(); // package → metadata

// How much of the previous chunk to carry forward to catch patterns that span chunk boundaries.
const OVERLAP = 512;

/**
 * Streams a Play Store page and extracts metadata without accumulating the full HTML.
 * Keeps only a small overlap buffer between chunks — O(OVERLAP) memory per request.
 *
 * Returns null when HTTP 404 (app not on store).
 * Returns { appName, rating, downloads, hasAds, category } on success.
 */
function fetchAndExtract(url) {
  return new Promise((resolve, reject) => {
    const state = {
      appName:   null,
      rating:    null,
      downloads: null,
      hasAds:    false,
      category:  null,
    };
    let tail = ""; // overlap from previous chunk
    let found404 = false;

    const req = https.get(url, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Linux; Android 10; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }, (res) => {
      if (res.statusCode === 404) { res.resume(); res.on("end", () => resolve(null)); return; }

      res.setEncoding("utf8");
      res.on("data", chunk => {
        const window = tail + chunk;
        scanChunk(window, state);
        tail = window.length > OVERLAP ? window.slice(-OVERLAP) : window;
      });
      res.on("end", () => resolve(state));
      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

/** Apply all extraction regexes to a window string, updating state in-place. */
function scanChunk(w, s) {
  if (!s.appName) {
    const m =
      w.match(/<title[^>]*>([^<]+?)(?:\s*-\s*Apps on Google Play)?<\/title>/i) ||
      w.match(/itemprop="name"[^>]*>([^<]+)<\/span>/i) ||
      w.match(/<span[^>]*itemprop="name"[^>]*>([^<]+)<\/span>/i);
    if (m) {
      s.appName = m[1]
        .replace(/ - Apps on Google Play$/i, "")
        .replace(/ – Google Play$/i, "")
        .trim() || null;
    }
  }

  if (s.rating === null) {
    const m =
      w.match(/class="TT9eCd"[^>]*>([\d.]+)</) ||
      w.match(/aria-label="Rated ([\d.]+) stars? out of five stars?"/) ||
      w.match(/starRating"[^>]*>([\d.]+)</);
    if (m) {
      const val = parseFloat(m[1]);
      if (val >= 1 && val <= 5) s.rating = val;
    }
  }

  if (!s.downloads) {
    const m =
      w.match(/class="ClM7O">([^<]+)<\/div><div[^>]*>[^<]*[Dd]ownload/) ||
      w.match(/>([\d,.]+[KMBT]?\+?)<\/div><div[^>]*>[^<]*[Dd]ownload/);
    if (m) s.downloads = m[1].trim();
  }

  if (!s.hasAds) {
    s.hasAds = /contains ads/i.test(w) || /containsAds["\s]*:\s*true/i.test(w);
  }

  if (!s.category) {
    const m = w.match(/"applicationCategory"\s*:\s*"([^"]+)"/);
    if (m) {
      s.category = m[1].toLowerCase().replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    }
  }
}

/** Full HTML fetch — used only by fetchTopPackages (package-list scrape, not per-app metadata). */
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Linux; Android 10; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }, (res) => {
      if (res.statusCode === 404) { resolve(null); return; }
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

/**
 * Looks up a package on Google Play and returns metadata.
 * Returns: { appName, rating, downloads, hasAds, storeUrl, stillOnStore }
 */
async function lookupPlayStore(packageName) {
  if (CACHE.has(packageName)) return CACHE.get(packageName);

  const storeUrl = `https://play.google.com/store/apps/details?id=${packageName}&hl=en`;

  let result = {
    appName: null,
    rating: null,
    downloads: null,
    hasAds: null,
    storeUrl,
    stillOnStore: false,
    error: null,
  };

  try {
    const data = await fetchAndExtract(storeUrl);
    if (!data) {
      result.stillOnStore = false;
    } else {
      result = { ...result, ...data, stillOnStore: true };
    }
  } catch (err) {
    result.error = err.message;
  }

  CACHE.set(packageName, result);
  return result;
}

/**
 * Batch lookup with concurrency limit.
 */
async function lookupMany(packageNames, concurrency = 3, onProgress = null) {
  const results = {};
  const queue = [...packageNames];
  let completed = 0;

  async function worker() {
    while (queue.length > 0) {
      const pkg = queue.shift();
      if (!pkg) continue;
      results[pkg] = await lookupPlayStore(pkg);
      completed++;
      if (onProgress) onProgress(completed, packageNames.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, packageNames.length) }, worker);
  await Promise.all(workers);
  return results;
}

function clearCache() {
  CACHE.clear();
}

/**
 * Fetch top package IDs in a Play Store category.
 * Primary: google-play-scraper lib (RPC-backed, supports num up to ~120 per collection).
 * Iterates multiple collections (TOP_FREE, TOP_PAID, TOP_GROSSING, NEW_FREE, NEW_PAID)
 * and merges/dedupes to reach N.
 * Fallback: legacy HTML scrape (capped ~30-50 per category cluster).
 *
 * @param {string} catId  e.g. "GAME_ACTION", "SOCIAL"
 * @param {number} n      target package count
 * @returns {Promise<string[]>}  list of package IDs (may be < n if Play Store cap hit)
 */
async function fetchTopPackages(catId, n) {
  if (!catId || n <= 0) return [];

  const seen = new Set();
  const order = [];

  // Primary path: google-play-scraper
  try {
    const gplay = require("google-play-scraper").default || require("google-play-scraper");
    const collections = [
      gplay.collection.TOP_FREE,
      gplay.collection.TOP_PAID,
      gplay.collection.TOP_GROSSING,
      gplay.collection.NEW_FREE,
      gplay.collection.NEW_PAID,
    ].filter(Boolean);

    for (const collection of collections) {
      if (order.length >= n) break;
      try {
        const list = await gplay.list({
          category: catId,
          collection,
          num: Math.min(n, 250),
          country: "us",
          lang: "en",
          fullDetail: false,
        });
        for (const app of list) {
          const pkg = app && app.appId;
          if (!pkg || !pkg.includes(".")) continue;
          if (seen.has(pkg)) continue;
          seen.add(pkg);
          order.push(pkg);
          if (order.length >= n) break;
        }
      } catch { /* try next collection */ }
    }
  } catch { /* lib missing → fallback */ }

  if (order.length >= n) return order.slice(0, n);

  // Fallback: legacy HTML scrape
  const charts = [
    "topselling_free",
    "topselling_paid",
    "topgrossing",
    "topselling_new_free",
    "topselling_new_paid",
    "movers_shakers",
  ];
  const candidateUrls = [
    `https://play.google.com/store/apps/category/${catId}?hl=en&gl=us`,
    `https://play.google.com/store/apps/category/${catId}`,
    ...charts.map(c => `https://play.google.com/store/apps/category/${catId}/collection/${c}?hl=en&gl=us`),
    ...charts.map(c => `https://play.google.com/store/apps/collection/${c}?hl=en&gl=us`),
  ];

  for (const url of candidateUrls) {
    if (order.length >= n) break;
    let html;
    try { html = await fetchHtml(url); } catch { continue; }
    if (!html) continue;

    const re = /\/store\/apps\/details\?id=([a-zA-Z0-9_.]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const pkg = m[1];
      if (!pkg.includes(".")) continue;
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      order.push(pkg);
      if (order.length >= n) break;
    }
  }

  return order.slice(0, n);
}

module.exports = { lookupPlayStore, lookupMany, clearCache, fetchTopPackages };
