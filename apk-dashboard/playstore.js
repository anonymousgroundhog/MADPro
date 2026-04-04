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

module.exports = { lookupPlayStore, lookupMany, clearCache };
