import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";

const SITE_ROOT = "https://www.raphaelleonardlevy.com";
const SITEMAP_URL = `${SITE_ROOT}/sitemap.xml`;
const ONLY_PATH_PREFIX = "/jeansellem/";

// Limite de pages (sécurité pendant tests). Mets à null pour tout indexer.
const LIMIT = null;

// Coupe le contenu pour éviter un index énorme (FlexSearch en front).
const MAX_CHARS_PER_RECORD = 18000;

// Concurrence raisonnable pour GitHub Actions + Squarespace
const CONCURRENCY = 8;

// Timeout fetch (évite qu'une page bloque tout le build)
const FETCH_TIMEOUT_MS = 25000; // 25s

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

function looksLikeCodeNoise(s){
  const t = String(s || "");

  if (!t) return true;

  if (/(display:|position:|font-size:|line-height:|justify-content:|align-items:|grid-template|@media|function\s*\(|=>|const\s+|let\s+|var\s+|document\.|window\.|\.sqs-|#rl-|\.rl-|addEventListener\(|querySelector\()/i.test(t)) {
    return true;
  }

  const punct = (t.match(/[{};]/g) || []).length;
  if (punct > 12 && /[{}]/.test(t)) return true;

  return false;
}

function uniqueTextBlocks(items){
  const seen = new Set();

  const base = items
    .map(htmlToText)
    .map(cleanText)
    .filter(Boolean)
    .filter(function(t){
      const key = normalizeForDedup(t);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(function(t){
      return { text: t, key: normalizeForDedup(t) };
    });

  const filtered = base.filter(function(item, i){
    return !base.some(function(other, j){
      if (i === j) return false;
      if (other.key.length <= item.key.length) return false;
      if (item.key.length < 40) return false;
      return other.key.includes(item.key);
    });
  });

  return filtered.map(function(x){ return x.text; });
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

function getViewerTitleFromDvConfig($){
  const cfgEl = $('script.dv-config[type="application/json"]').first();
  if (!cfgEl.length) return "";
  try{
    const cfg = JSON.parse(cfgEl.text() || "{}");
    return cleanText(cfg?.title || "");
  }catch(_){
    return "";
  }
}

// Extrait du texte indexable depuis le JSON dv-config (si présent dans le HTML)
function extractViewerTextFromDvConfig($){
  const cfgEls = $('script.dv-config[type="application/json"]');
  if (!cfgEls.length) return "";

  const chunks = [];
  const seen = new Set();

  const looksLikeUrl = (s) =>
    /^https?:\/\//i.test(s) ||
    /raw\.githubusercontent\.com/i.test(s) ||
    /\.(jpg|jpeg|png|webp|gif|pdf)(\?|$)/i.test(s);

  const skipKey = (k) =>
    /(url|href|src|front|back|img|image|thumb|gallery|hd_base|base|media|pdf|file|originals)/i.test(k);

  const takeKey = (k) =>
    /(title|artist|exhibition|dates|text|content|description|caption|remark|note|summary|comment|letter|press|publication|book|poem|biography)/i.test(k);

  function pushChunk(value){
    const t = htmlToText(value);
    if (!t) return;
    if (looksLikeUrl(t)) return;
    if (looksLikeCodeNoise(t)) return;

    const key = normalizeForDedup(t);
    if (!key || seen.has(key)) return;

    seen.add(key);
    chunks.push(t);
  }

  function walk(node, keyHint = ""){
    if (node == null) return;

    if (typeof node === "string"){
      const t = htmlToText(node);
      if (!t) return;
      if (looksLikeUrl(t)) return;
      if (looksLikeCodeNoise(t)) return;

      if (keyHint){
        if (skipKey(keyHint)) return;
        if (!takeKey(keyHint) && t.length < 6) return;
      }

      pushChunk(t);
      return;
    }

    if (Array.isArray(node)){
      node.forEach(v => walk(v, keyHint));
      return;
    }

    if (typeof node === "object"){
      for (const [k, v] of Object.entries(node)){
        walk(v, k);
      }
    }
  }

  cfgEls.each((_, el) => {
    try{
      const cfg = JSON.parse($(el).text() || "{}");
      walk(cfg, "");
    }catch(_){}
  });

  return uniqueTextBlocks(chunks).join(" ");
}

function stripNoiseFromClone($root){
  const NOISE_SELECTORS = [
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "iframe",

    "footer",
    ".Footer",
    "#footer",
    "#rl-search",
    "#rl-footer-slot",
    ".rll-visit-footer",

    "header",
    ".Header",
    "#header",
    ".site-header",
    "#custom-header-jeansellem",

    ".contact-float-right",
    ".contact-form-panel",
    ".header-buttons",
    ".selection-panel",
    ".selection-button",

    ".poster-hint",
    ".jsl-trigger",

    ".sqs-block-code",
    "pre",
    "code"
  ];

  NOISE_SELECTORS.forEach(sel => {
    $root.find(sel).remove();
  });

  return $root;
}

function extractContent($){
  const chunks = [];
  let hasViewer = false;
  let hasPopup = false;
  let hasPage = false;

  // 1) Viewer
  const dvz = $(".dvz-indexable-text").first();
  const dvzText = dvz.length ? htmlToText(dvz.text()) : "";
  const cfgText = extractViewerTextFromDvConfig($);
  const viewerText = cleanText([dvzText, cfgText].filter(Boolean).join(" "));

  if (viewerText){
    chunks.push(viewerText);
    hasViewer = true;
  }

  // 2) Popup
  const pop = $(".jsl-popup-content").first();
  if (pop.length){
    const meta = [
      cleanText($(".jsl-artist").first().text()),
      cleanText($(".jsl-exhibition").first().text()),
      cleanText($(".jsl-dates").first().text())
    ].filter(Boolean).join(" — ");

    const body = htmlToText(pop.html() || pop.text());
    const joined = cleanText([meta, body].filter(Boolean).join(" "));
    if (joined){
      chunks.push(joined);
      hasPopup = true;
    }
  }

  // 2bis) Press release stocké dans des attributs HTML
  const attrCandidates = [
    "[data-caption]",
    "[data-press]",
    "[data-popup]",
    "[data-description]",
    "[data-content]"
  ];

  attrCandidates.forEach(function(sel){
    $(sel).each((_, el) => {
      const vals = [
        $(el).attr("data-caption"),
        $(el).attr("data-press"),
        $(el).attr("data-popup"),
        $(el).attr("data-description"),
        $(el).attr("data-content")
      ].filter(Boolean);

      vals.forEach(function(v){
        const t = htmlToText(v);
        if (t){
          chunks.push(t);
          hasPopup = true;
        }
      });
    });
  });

  // 3) Main page content, nettoyé
  const main = $("main").first().clone();
  if (main.length){
    stripNoiseFromClone(main);

    // évite les doublons déjà gérés plus haut
    main.find(".dvz-indexable-text").remove();
    main.find(".jsl-popup-content").remove();

    const t = htmlToText(main.html() || main.text());
    if (t){
      chunks.push(t);
      hasPage = true;
    }
  }

  const uniqueChunks = uniqueTextBlocks(chunks);
  const content = cleanText(uniqueChunks.join(" "));

  let section = "page";
  if (hasViewer) section = "viewer";
  else if (hasPopup) section = "popup";
  else if (hasPage) section = "page";

  return { content, section };
}

async function fetchText(url){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try{
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "rll-search-index-bot/1.0 (+github actions)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  }catch(e){
    if (e?.name === "AbortError") throw new Error(`Timeout ${FETCH_TIMEOUT_MS}ms for ${url}`);
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

async function fetchSitemapUrls(){
  const xml = await fetchText(SITEMAP_URL);
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);

  const urls = []
    .concat(parsed?.urlset?.url || [])
    .map(u => (typeof u === "string" ? u : u?.loc))
    .filter(Boolean);

  const filtered = urls
    .filter(u => {
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
  return fn => new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject));
    next();
  });
}

async function main(){
  const urls = await fetchSitemapUrls();
  console.log(`Sitemap URLs (/jeansellem): ${urls.length}`);

  const limit = pLimit(CONCURRENCY);
  const records = [];

  let done = 0;
  const total = urls.length;

  await Promise.all(urls.map(url => limit(async () => {
    try{
      const html = await fetchText(url);
      const $ = cheerio.load(html);

      const dvTitle = getViewerTitleFromDvConfig($);
      const title = dvTitle || getTitle($) || url;

      const { content, section } = extractContent($);
      if (!content) return;

      const year = guessYearFromUrl(url);
      const tags = [];
      if (section) tags.push(section);
      if (year) tags.push(`year:${year}`);
      tags.push("jeansellem");

      records.push({
        id: `u:${sha10(url)}:${section}`,
        url,
        title,
        content: content.slice(0, MAX_CHARS_PER_RECORD),
        tags,
        section
      });
    }catch(e){
      console.error(`Skip ${url}: ${e.message}`);
    }finally{
      done++;
      if (done % 20 === 0 || done === total){
        console.log(`Progress: ${done}/${total}`);
      }
    }
  })));

  records.sort((a,b) => (a.url || "").localeCompare(b.url || ""));

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
    sections: records.reduce((acc,r)=>{ acc[r.section]=(acc[r.section]||0)+1; return acc; }, {})
  };
  fs.writeFileSync(path.join(outDir, "index-meta.json"), JSON.stringify(meta,null,2), "utf8");

  console.log(`Wrote: ${outJs} (${records.length} records)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
