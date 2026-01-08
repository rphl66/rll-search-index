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

  const looksLikeUrl = (s) =>
    /^https?:\/\//i.test(s) ||
    /raw\.githubusercontent\.com/i.test(s) ||
    /\.(jpg|jpeg|png|webp|gif|pdf)(\?|$)/i.test(s);

  const skipKey = (k) =>
    /(url|href|src|front|back|img|image|thumb|gallery|hd_base|base|media|pdf|file|originals)/i.test(k);

  const takeKey = (k) =>
    /(title|artist|exhibition|dates|text|content|description|caption|remark|note|summary)/i.test(k);

  function walk(node, keyHint = ""){
    if (node == null) return;

    if (typeof node === "string"){
      const t = cleanText(node);
      if (!t) return;
      if (looksLikeUrl(t)) return;

      if (keyHint){
        if (skipKey(keyHint)) return;
        if (!takeKey(keyHint) && t.length < 6) return;
      }

      chunks.push(t);
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

  return cleanText(chunks.join(" "));
}

function extractContent($){
  // 1) Viewer (dvz-indexable-text OU dv-config JSON)
  const dvz = $(".dvz-indexable-text").first();
  const dvzText = dvz.length ? cleanText(dvz.text()) : "";
  const cfgText = extractViewerTextFromDvConfig($);

  const viewerText = cleanText([dvzText, cfgText].filter(Boolean).join(" "));
  if (viewerText) return { content: viewerText, section: "viewer" };

  // 2) Popup content
  const pop = $(".jsl-popup-content").first();
  if (pop.length){
    const meta = [
      cleanText($(".jsl-artist").first().text()),
      cleanText($(".jsl-exhibition").first().text()),
      cleanText($(".jsl-dates").first().text())
    ].filter(Boolean).join(" — ");

    const body = cleanText(pop.text());
    const joined = cleanText([meta, body].filter(Boolean).join(" "));
    if (joined) return { content: joined, section: "popup" };
  }

  // 3) Fallback Squarespace blocks / main
  const blocks = $(".sqs-block-content");
  if (blocks.length){
    const t = cleanText(blocks.text());
    if (t) return { content: t, section: "page" };
  }

  const main = $("main");
  if (main.length){
    const t = cleanText(main.text());
    if (t) return { content: t, section: "page" };
  }

  return { content: "", section: "page" };
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
*/\nwindow.__RLL_INDEX__ = ${JSON.stringify(records)};\n`;

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
