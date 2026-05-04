/**
 * playstore.js
 * Fetches app metadata from Google Play Store using web scraping.
 * Fields retrieved: appName, rating, downloads, hasAds, storeUrl, stillOnStore.
 */

const https = require("https");

const CACHE = new Map(); // package → metadata

/**
 * Fetches raw HTML from a URL via https.get (no external deps).
 */
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 10; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      (res) => {
        if (res.statusCode === 404) {
          resolve(null); // app not found
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/**
 * Extracts a value from Play Store HTML using regex patterns on the JSON blobs.
 */
function extractPlayData(html) {
  if (!html) return null;

  // App name — from <title ...> or itemprop="name"
  const nameMatch =
    html.match(/<title[^>]*>([^<]+?)(?:\s*-\s*Apps on Google Play)?<\/title>/i) ||
    html.match(/itemprop="name"[^>]*>([^<]+)<\/span>/i) ||
    html.match(/<span[^>]*itemprop="name"[^>]*>([^<]+)<\/span>/i);
  const appName = (nameMatch?.[1] ?? "")
    .replace(/ - Apps on Google Play$/i, "")
    .replace(/ – Google Play$/i, "")
    .trim() || null;

  // Rating — Play Store uses class "TT9eCd" for the numeric rating value
  // e.g. class="TT9eCd" aria-label="Rated 4.7 stars out of five stars">4.7<
  let rating = null;
  const ratingM =
    html.match(/class="TT9eCd"[^>]*>([\d.]+)</) ||
    html.match(/aria-label="Rated ([\d.]+) stars? out of five stars?"/) ||
    html.match(/starRating"[^>]*>([\d.]+)</);
  if (ratingM) {
    const val = parseFloat(ratingM[1]);
    if (val >= 1 && val <= 5) rating = val;
  }

  // Downloads — Play Store uses class "ClM7O" for the count, followed by "g1rdde">Downloads
  // e.g. <div class="ClM7O">10B+</div><div class="g1rdde">Downloads</div>
  const dlM =
    html.match(/class="ClM7O">([^<]+)<\/div><div[^>]*>[^<]*[Dd]ownload/) ||
    html.match(/>([\d,.]+[KMBT]?\+?)<\/div><div[^>]*>[^<]*[Dd]ownload/);
  const downloads = dlM?.[1]?.trim() ?? null;

  // Ads detection — Play Store shows "Contains ads" as a text badge
  const hasAds =
    /contains ads/i.test(html) ||
    /containsAds["\s]*:\s*true/i.test(html);

  // Category — embedded as JSON: "applicationCategory":"COMMUNICATION"
  const rawCategory = html.match(/"applicationCategory"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  const category = rawCategory
    ? rawCategory.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : null;

  return { appName, rating, downloads, hasAds, category };
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
    const html = await fetchHtml(storeUrl);
    if (!html) {
      result.stillOnStore = false;
    } else {
      const data = extractPlayData(html);
      result = {
        ...result,
        ...data,
        stillOnStore: true,
      };
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
