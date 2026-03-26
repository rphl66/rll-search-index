import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";

const SITE_ROOT = "https://www.raphaelleonardlevy.com";
const SITEMAP_URL = `${SITE_ROOT}/sitemap.xml`;
const ONLY_PATH_PREFIX = "/jeansellem/";

const LIMIT = null;
const MAX_CHARS_PER_RECORD = 30000;
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 25000;

function sha10(s){
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
}

function cleanText(s){
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToText(s){
  const raw = String(s || "");
  if (!raw) return "";

  if (!/[<>]/.test(raw)) return cleanText(raw);

  try{
    const $frag = cheerio.load(`<div>${raw}</div>`);
    return cleanText($frag.root().text());
  }catch(_){
    return cleanText(raw.replace(/<[^>]+>/g, " "));
  }
}

function normalizeForDedup(s){
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueTextBlocks(items){
  const seen = new Set();

  return items
    .map(htmlToText)
    .map(cleanText)
    .filter(Boolean)
    .filter((t) => {
      const key = normalizeForDedup(t);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function guessYearFromUrl(url){
  const m = String(url).match(/\/jeansellem\/(19[0-9]{2})(?:\/|$)/);
  return m ? m[1] : "";
}

function getTitle($){
  const og = $('meta[property="og:title"]').attr("content");
  const t = $("title").text();
  return cleanText(og || t || "");
}

function fetchText(url){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  return fetch(url, {
    signal: controller.signal,
    headers: {
      "user-agent": "rll-search-index-bot/2.0 (+github actions)",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.text();
    })
    .catch((e) => {
      if (e?.name === "AbortError"){
        throw new Error(`Timeout ${FETCH_TIMEOUT_MS}ms for ${url}`);
      }
      throw e;
    })
    .finally(() => {
      clearTimeout(timer);
    });
}

async function fetchSitemapUrls(){
  const xml = await fetchText(SITEMAP_URL);
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);

  const urls = []
    .concat(parsed?.urlset?.url || [])
    .map((u) => (typeof u === "string" ? u : u?.loc))
    .filter(Boolean);

  const filtered = urls
    .filter((u) => {
      try{
        const p = new URL(u).pathname;
        return p.startsWith(ONLY_PATH_PREFIX);
      }catch(_){
        return false;
      }
    })
    .sort();

  return LIMIT ? filtered.slice(0, LIMIT) : filtered;
}

function pLimit(concurrency){
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

  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject));
    next();
  });
}

function stripNoiseFromClone($root){
  const NOISE_SELECTORS = [
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "iframe",
    "header",
    ".Header",
    "#header",
    ".site-header",
    "#custom-header-jeansellem",
    "footer",
    ".Footer",
    "#footer",
    "#rl-search",
    "#rl-footer-slot",
    ".rll-visit-footer",
    ".contact-float-right",
    ".contact-form-panel",
    ".header-buttons",
    ".selection-panel",
    ".selection-button",
    ".poster-hint",
    ".jsl-trigger",
    ".jsl-artwork",          // IMPORTANT : on retire tout le bloc popup de la page
    ".jsl-popup-content",    // IMPORTANT : idem
    ".event-archive-block",
    ".dvz-indexable-text",
    "button",
    "audio",
    "video",
    "source",
    "pre",
    "code"
  ];

  NOISE_SELECTORS.forEach((sel) => {
    $root.find(sel).remove();
  });

  return $root;
}

function buildTags(url, section){
  const year = guessYearFromUrl(url);
  const tags = ["jeansellem", section];
  if (year) tags.push(`year:${year}`);
  return tags;
}

function makeRecord({ id, url, title, content, section, tags }){
  const t = cleanText(title || url || "");
  const c = cleanText(content || "");

  if (!c) return null;

  return {
    id,
    url,
    title: t,
    content: c.slice(0, MAX_CHARS_PER_RECORD),
    tags: Array.isArray(tags) ? tags : [],
    section
  };
}

function extractPopupRecords($, url){
  const records = [];
  const baseId = sha10(url);

  $(".jsl-artwork[data-jsl]").each((i, el) => {
    const $block = $(el);
    const $pop = $block.find(".jsl-popup-content").first();
    if (!$pop.length) return;

    const artist =
      cleanText($block.find(".jsl-artist").first().text()) ||
      cleanText($block.attr("data-artist"));

    const exhibition =
      cleanText($block.find(".jsl-exhibition").first().text()) ||
      cleanText($block.attr("data-exhibition"));

    const dates =
      cleanText($block.find(".jsl-dates").first().text()) ||
      cleanText($block.attr("data-dates"));

    const content = htmlToText($pop.html() || $pop.text());
    if (!content) return;

    const title = [artist, exhibition, dates].filter(Boolean).join(" ");
    const tags = buildTags(url, "popup").concat(["press-release"]);

    const rec = makeRecord({
      id: `u:${baseId}:popup:${i}`,
      url,
      title,
      content,
      section: "popup",
      tags
    });

    if (rec) records.push(rec);
  });

  return records;
}

function extractViewerRecords($, url, fallbackTitle){
  const records = [];
  const baseId = sha10(url);

  $(".event-archive-block").each((i, el) => {
    const $block = $(el);
    const $txt = $block.find(".dvz-indexable-text").first();
    if (!$txt.length) return;

    let title = fallbackTitle || url;

    const cfgEl = $block.find('script.dv-config[type="application/json"]').first();
    if (cfgEl.length){
      try{
        const cfg = JSON.parse(cfgEl.text() || "{}");
        if (cfg?.title) title = cleanText(cfg.title);
      }catch(_){}
    }

    const content = htmlToText($txt.html() || $txt.text());
    if (!content) return;

    const tags = buildTags(url, "viewer").concat(["event-archive"]);

    const rec = makeRecord({
      id: `u:${baseId}:viewer:${i}`,
      url,
      title,
      content,
      section: "viewer",
      tags
    });

    if (rec) records.push(rec);
  });

  return records;
}

function extractPageRecord($, url, fallbackTitle){
  const main = $("main").first().clone();
  if (!main.length) return null;

  stripNoiseFromClone(main);

  const content = uniqueTextBlocks([
    main.html() || main.text()
  ]).join(" ");

  if (!content) return null;

  return makeRecord({
    id: `u:${sha10(url)}:page`,
    url,
    title: fallbackTitle || url,
    content,
    section: "page",
    tags: buildTags(url, "page")
  });
}

async function main(){
  const urls = await fetchSitemapUrls();
  console.log(`Sitemap URLs (/jeansellem): ${urls.length}`);

  const limit = pLimit(CONCURRENCY);
  const records = [];

  let done = 0;
  const total = urls.length;

  await Promise.all(
    urls.map((url) =>
      limit(async () => {
        try{
          const html = await fetchText(url);
          const $ = cheerio.load(html);
          const pageTitle = getTitle($) || url;

          const popupRecords = extractPopupRecords($, url);
          const viewerRecords = extractViewerRecords($, url, pageTitle);
          const pageRecord = extractPageRecord($, url, pageTitle);

          popupRecords.forEach((r) => records.push(r));
          viewerRecords.forEach((r) => records.push(r));
          if (pageRecord) records.push(pageRecord);
        }catch(e){
          console.error(`Skip ${url}: ${e.message}`);
        }finally{
          done++;
          if (done % 20 === 0 || done === total){
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
*/\nwindow.__RLL_INDEX__ = ${JSON.stringify(records, null, 2)};\n`;

  fs.writeFileSync(outJs, payload, "utf8");

  const meta = {
    built_at: new Date().toISOString(),
    site_root: SITE_ROOT,
    sitemap: SITEMAP_URL,
    count: records.length,
    sections: records.reduce((acc, r) => {
      acc[r.section] = (acc[r.section] || 0) + 1;
      return acc;
    }, {})
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
