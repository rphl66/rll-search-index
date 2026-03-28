import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";

const SITE_ROOT = "https://www.raphaelleonardlevy.com";
const SITEMAP_URL = `${SITE_ROOT}/sitemap.xml`;
const ONLY_PATH_PREFIX = "/jeansellem/";

const LIMIT = null;
const MAX_CHARS_PER_RECORD = 120000;
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 25000;

function sha10(s) {
  return crypto
    .createHash("sha1")
    .update(String(s))
    .digest("hex")
    .slice(0, 10);
}

function cleanText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToText(s) {
  const raw = String(s || "");
  if (!raw) return "";
  if (!/[<>]/.test(raw)) return cleanText(raw);

  try {
    const prepared = raw
      .replace(/<br\s*\/?>/gi, " ")
      .replace(
        /<\/(p|div|section|article|header|footer|li|ul|ol|h1|h2|h3|h4|h5|h6|blockquote|pre|table|tr|td|th)>/gi,
        " "
      )
      .replace(
        /<(p|div|section|article|header|footer|li|ul|ol|h1|h2|h3|h4|h5|h6|blockquote|pre|table|tr|td|th)\b[^>]*>/gi,
        " "
      );

    const $frag = cheerio.load(`<div>${prepared}</div>`);
    return cleanText($frag.root().text());
  } catch (_) {
    return cleanText(
      raw
        .replace(/<br\s*\/?>/gi, " ")
        .replace(
          /<\/(p|div|section|article|header|footer|li|ul|ol|h1|h2|h3|h4|h5|h6|blockquote|pre|table|tr|td|th)>/gi,
          " "
        )
        .replace(
          /<(p|div|section|article|header|footer|li|ul|ol|h1|h2|h3|h4|h5|h6|blockquote|pre|table|tr|td|th)\b[^>]*>/gi,
          " "
        )
        .replace(/<[^>]+>/g, " ")
    );
  }
}

function slugify(s) {
  return cleanText(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function popupKeyFromParts(artist, exhibition, dates) {
  return [artist, exhibition, dates]
    .map(slugify)
    .filter(Boolean)
    .join("__");
}

function buildDeepUrl(url, paramsObj) {
  const u = new URL(url);
  const params = new URLSearchParams();

  Object.keys(paramsObj || {}).forEach((key) => {
    const val = paramsObj[key];
    if (val != null && String(val).trim() !== "") {
      params.set(key, String(val));
    }
  });

  return `${u.origin}${u.pathname}#${params.toString()}`;
}

function guessYearFromUrl(url) {
  const m = String(url).match(/\/jeansellem\/(19[0-9]{2})(?:\/|$)/);
  return m ? m[1] : "";
}

function getTitle($) {
  const og = $('meta[property="og:title"]').attr("content");
  const t = $("title").text();
  return cleanText(og || t || "");
}

function getViewerTitleFromCfgText(txt) {
  try {
    const cfg = JSON.parse(txt || "{}");
    return cleanText(cfg?.title || "");
  } catch (_) {
    return "";
  }
}

function extractViewerTextFromConfigNode($node) {
  if (!$node || !$node.length) return "";

  const buckets = { core: [], fr: [], de: [], en: [] };

  const looksLikeUrl = (s) =>
    /^https?:\/\//i.test(s) ||
    /raw\.githubusercontent\.com/i.test(s) ||
    /\.(jpg|jpeg|png|webp|gif|pdf)(\?|$)/i.test(s);

  const keepKey = (k) =>
    /^(title|artist|exhibition|dates|text|text_en|text_fr|text_de|text_back|text_back_en|text_back_fr|text_back_de|content|content_en|content_fr|content_de|description|description_en|description_fr|description_de|caption|caption_en|caption_fr|caption_de|remark|remark_en|remark_fr|remark_de|note|note_en|note_fr|note_de|summary|summary_en|summary_fr|summary_de)$/i.test(
      String(k || "").trim()
    );

  const skipKey = (k) =>
    /^(url|href|src|front|back|img|image|thumb|gallery|hd_base|base|media|pdf|file|originals)$/i.test(
      String(k || "").trim()
    );

  function bucketForKey(k) {
    const key = String(k || "").trim().toLowerCase();
    if (/_fr$/.test(key)) return "fr";
    if (/_de$/.test(key)) return "de";
    if (/_en$/.test(key)) return "en";
    return "core";
  }

  function pushText(value, bucketName) {
    const txt = htmlToText(value);
    if (!txt) return;
    if (looksLikeUrl(txt)) return;
    buckets[bucketName].push(txt);
  }

  function walk(node, keyHint = "") {
    if (node == null) return;

    if (typeof node === "string") {
      const raw = String(node || "");
      if (!raw.trim()) return;

      if (keyHint) {
        if (keepKey(keyHint)) {
          pushText(raw, bucketForKey(keyHint));
          return;
        }

        if (skipKey(keyHint)) {
          return;
        }

        const shortTxt = htmlToText(raw);
        if (shortTxt.length < 6) return;

        pushText(raw, "core");
        return;
      }

      pushText(raw, "core");
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((v) => walk(v, keyHint));
      return;
    }

    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        walk(v, k);
      }
    }
  }

  function packBucket(arr, maxChars) {
    let out = "";

    for (const part of arr) {
      const txt = cleanText(part);
      if (!txt) continue;

      const next = out ? `${out} ${txt}` : txt;

      if (next.length <= maxChars) {
        out = next;
      } else {
        const room = maxChars - out.length - (out ? 1 : 0);
        if (room > 40) {
          out += (out ? " " : "") + txt.slice(0, room);
        }
        break;
      }
    }

    return cleanText(out);
  }

  try {
    const cfg = JSON.parse($node.text() || "{}");
    walk(cfg, "");
  } catch (_) {}

  return cleanText(
    [
      packBucket(buckets.core, 4000),
      packBucket(buckets.fr, 8000),
      packBucket(buckets.de, 8000),
      packBucket(buckets.en, 8000),
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function extractViewerTextFromObject(obj) {
  return extractViewerTextFromConfigNode({
    length: 1,
    text: function () {
      return JSON.stringify(obj || {});
    }
  });
}

function getViewerPageTitle(page, cfgTitle, fallbackTitle) {
  if (!page || typeof page !== "object") return cfgTitle || fallbackTitle || "";

  const title = cleanText(
    page.title ||
      page.page_title ||
      page.head ||
      page.header ||
      ""
  );

  if (title) return title;

  const artist = cleanText(page.artist || "");
  const exhibition = cleanText(page.exhibition || "");
  const dates = cleanText(page.date || page.dates || "");

  const composed = cleanText(
    [dates, artist, exhibition].filter(Boolean).join(" ")
  );

  return composed || cfgTitle || fallbackTitle || "";
}

function readViewerConfigData($, $block) {
  const rawCandidates = [];

  function pushRaw(txt) {
    const raw = String(txt || "").trim();
    if (!raw) return;
    if (rawCandidates.indexOf(raw) === -1) rawCandidates.push(raw);
  }

  pushRaw($block.find('script.dv-config[type="application/json"]').first().text());
  pushRaw($block.find(".dv-config").first().text());

  $block.find("script").each((_, el) => {
    const txt = String($(el).text() || "");
    if (
      /"pages"\s*:/.test(txt) ||
      /"text_fr"\s*:/.test(txt) ||
      /"text_de"\s*:/.test(txt) ||
      /"text_en"\s*:/.test(txt)
    ) {
      pushRaw(txt);
    }
  });

  for (const raw of rawCandidates) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        return { raw, obj };
      }
    } catch (_) {}
  }

  return { raw: "", obj: {} };
}

function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  return fetch(url, {
    signal: controller.signal,
    headers: {
      "user-agent": "rll-search-index-bot/2.0 (+github actions)",
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.text();
    })
    .catch((e) => {
      if (e?.name === "AbortError") {
        throw new Error(`Timeout ${FETCH_TIMEOUT_MS}ms for ${url}`);
      }
      throw e;
    })
    .finally(() => {
      clearTimeout(timer);
    });
}

async function fetchSitemapUrls() {
  const xml = await fetchText(SITEMAP_URL);
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);

  const urls = []
    .concat(parsed?.urlset?.url || [])
    .map((u) => (typeof u === "string" ? u : u?.loc))
    .filter(Boolean);

  const filtered = urls
    .filter((u) => {
      try {
        const p = new URL(u).pathname;
        return p.startsWith(ONLY_PATH_PREFIX);
      } catch (_) {
        return false;
      }
    })
    .sort();

  return LIMIT ? filtered.slice(0, LIMIT) : filtered;
}

function pLimit(concurrency) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (!job) return;

    active++;
    job().finally(() => {
      active--;
      next();
    });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject));
      next();
    });
}

function buildTags(url, section) {
  const year = guessYearFromUrl(url);
  const tags = ["jeansellem", section];
  if (year) tags.push(`year:${year}`);
  return tags;
}

function makeRecord({ id, url, title, content, section, tags }) {
  const t = cleanText(title || url || "");
  const c = cleanText(content || "");
  if (!c) return null;

  return {
    id,
    url,
    title: t,
    content: c.slice(0, MAX_CHARS_PER_RECORD),
    tags: Array.isArray(tags) ? tags : [],
    section,
  };
}

function extractPopupRecords($, url) {
  const records = [];
  const baseId = sha10(url);

  $(".jsl-artwork").each((i, el) => {
    const $card = $(el);
    const $pop = $card.find(".jsl-popup-content").first();
    if (!$pop.length) return;

    const artist = cleanText(
      $card.find(".jsl-artist").first().text() ||
        $card.attr("data-artist") ||
        ""
    );

    const exhibition = cleanText(
      $card.find(".jsl-exhibition").first().text() ||
        $card.attr("data-exhibition") ||
        ""
    );

    const dates = cleanText(
      $card.find(".jsl-dates").first().text() ||
        $card.attr("data-dates") ||
        ""
    );

    const title =
      [artist, exhibition, dates].filter(Boolean).join(" ") ||
      getTitle($) ||
      url;

    const content = htmlToText($pop.html() || $pop.text());
    if (!content) return;

    const popupKey =
      popupKeyFromParts(artist, exhibition, dates) || `popup-${i}`;

    const tags = buildTags(url, "popup").concat(["press-release"]);

    const rec = makeRecord({
      id: `u:${baseId}:popup:${i}`,
      url: buildDeepUrl(url, { open: "popup", k: popupKey }),
      title,
      content,
      section: "popup",
      tags,
    });

    if (rec) records.push(rec);
  });

  return records;
}

function extractViewerRecords($, url, fallbackTitle) {
  const records = [];
  const baseId = sha10(url);

  $(".event-archive-block").each((i, el) => {
    const $block = $(el);
    const $txt = $block.find(".dvz-indexable-text").first();
    const txtA = $txt.length ? cleanText($txt.text()) : "";

    const cfgData = readViewerConfigData($, $block);
    const cfgObj = cfgData.obj || {};
    const cfgRaw = cfgData.raw || "";

    const cfgTitle =
      getViewerTitleFromCfgText(cfgRaw) || fallbackTitle || url;

    const viewerUrl = buildDeepUrl(url, { open: "viewer", i: String(i) });
    const tags = buildTags(url, "viewer").concat(["event-archive"]);

    // CAS PRINCIPAL : un record par page interne du viewer
    if (Array.isArray(cfgObj.pages) && cfgObj.pages.length) {
      cfgObj.pages.forEach((page, pageIndex) => {
        const pageText = extractViewerTextFromObject(page);
        if (!pageText) return;

        const rec = makeRecord({
          id: `u:${baseId}:viewer:${i}:p:${pageIndex}`,
          url: viewerUrl,
          title: getViewerPageTitle(page, cfgTitle, fallbackTitle),
          content: pageText,
          section: "viewer",
          tags,
        });

        if (rec) records.push(rec);
      });

      return;
    }

    // FALLBACK : mode agrégé si on ne parvient pas à lire cfg.pages
    const txtB = cfgRaw
      ? extractViewerTextFromConfigNode({
          length: 1,
          text: function () {
            return cfgRaw;
          }
        })
      : "";

    const rawBlockText = htmlToText($block.html() || "");

    const content = cleanText(
      [
        txtB,
        txtA ? txtA.slice(0, 6000) : "",
        rawBlockText ? rawBlockText.slice(0, 100000) : "",
      ]
        .filter(Boolean)
        .join(" ")
    );

    if (!content) return;

    const rec = makeRecord({
      id: `u:${baseId}:viewer:${i}`,
      url: viewerUrl,
      title: cfgTitle,
      content,
      section: "viewer",
      tags,
    });

    if (rec) records.push(rec);
  });

  return records;
}

function extractPageRecord($, url, fallbackTitle) {
  const blocks = $(".sqs-block-content");
  const content = blocks.length
    ? cleanText(blocks.text())
    : cleanText($("main").text());

  if (!content || content.length < 80) return null;

  return makeRecord({
    id: `u:${sha10(url)}:page`,
    url,
    title: fallbackTitle || url,
    content,
    section: "page",
    tags: buildTags(url, "page"),
  });
}

async function main() {
  const urls = await fetchSitemapUrls();
  console.log(`Sitemap URLs (/jeansellem): ${urls.length}`);

  const limit = pLimit(CONCURRENCY);
  const records = [];

  let done = 0;
  const total = urls.length;

  await Promise.all(
    urls.map((url) =>
      limit(async () => {
        try {
          const html = await fetchText(url);
          const $ = cheerio.load(html);

          const pageTitle = getTitle($) || url;
          const popupRecords = extractPopupRecords($, url);
          const viewerRecords = extractViewerRecords($, url, pageTitle);
          const hasStructuredRecords =
            popupRecords.length > 0 || viewerRecords.length > 0;

          const pageRecord = hasStructuredRecords
            ? null
            : extractPageRecord($, url, pageTitle);

          popupRecords.forEach((r) => records.push(r));
          viewerRecords.forEach((r) => records.push(r));
          if (pageRecord) records.push(pageRecord);
        } catch (e) {
          console.error(`Skip ${url}: ${e.message}`);
        } finally {
          done++;
          if (done % 20 === 0 || done === total) {
            console.log(`Progress: ${done}/${total}`);
          }
        }
      })
    )
  );

  records.sort((a, b) => {
    const u = (a.url || "").localeCompare(b.url || "");
    if (u !== 0) return u;
    return (a.id || "").localeCompare(b.id || "");
  });

  const outDir = path.resolve("docs");
  fs.mkdirSync(outDir, { recursive: true });

  const outJs = path.join(outDir, "index-jeansellem.js");
  const payload = `/* AUTO-GENERATED — DO NOT EDIT
Source: ${SITEMAP_URL}
Built: ${new Date().toISOString()}
*/
window.__RLL_INDEX__ = ${JSON.stringify(records)};
`;

  fs.writeFileSync(outJs, payload, "utf8");

  const meta = {
    built_at: new Date().toISOString(),
    site_root: SITE_ROOT,
    sitemap: SITEMAP_URL,
    count: records.length,
    sections: records.reduce((acc, r) => {
      acc[r.section] = (acc[r.section] || 0) + 1;
      return acc;
    }, {}),
  };

  fs.writeFileSync(
    path.join(outDir, "index-meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8"
  );

  console.log(`Wrote: ${outJs} (${records.length} records)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
