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

function extractContent($){
  // 1) Viewer EN-only hook
  const dvz = $(".dvz-indexable-text").first();
  if (dvz.length){
    const t = cleanText(dvz.text());
    if (t) return { content: t, section: "viewer" };
  }

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
  const res = await fetch(url, {
    headers: {
      "user-agent": "rll-search-index-bot/1.0 (+github actions)",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function fetchSitemapUrls(){
  const xml = await fetchText(SITEMAP_URL);
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);

  // Squarespace sitemap: urlset.url[].loc
  const urls = []
    .concat(parsed?.urlset?.url || [])
    .map(u => (typeof u === "string" ? u : u?.loc))
    .filter(Boolean);

  // filtre /jeansellem/
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

  await Promise.all(urls.map(url => limit(async () => {
    try{
      const html = await fetchText(url);
      const $ = cheerio.load(html);

      // titre
      const dvTitle = getViewerTitleFromDvConfig($);
      const title = dvTitle || getTitle($) || url;

      // contenu
      const { content, section } = extractContent($);
      if (!content) return;

      // tags
      const year = guessYearFromUrl(url);
      const tags = [];
      if (section) tags.push(section);
      if (year) tags.push(`year:${year}`);
      tags.push("jeansellem");

      const rec = {
        id: `u:${sha10(url)}:${section}`,
        url,
        title,
        content: content.slice(0, MAX_CHARS_PER_RECORD),
        tags,
        section
      };

      records.push(rec);
    }catch(e){
      console.error(`Skip ${url}: ${e.message}`);
    }
  })));

  // tri stable
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
