// Конвейер перевода: батчинг, кэш, ретраи, глоссарий.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { chat } from "./api.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(ROOT, ".cache");

const LANG_NAMES = {
  ru_ru: "Russian",
  uk_ua: "Ukrainian",
  de_de: "German",
  fr_fr: "French",
  es_es: "Spanish",
  pt_br: "Brazilian Portuguese",
  pl_pl: "Polish",
  zh_cn: "Simplified Chinese",
};

function langName(lang) {
  return LANG_NAMES[lang.toLowerCase()] ?? lang;
}

function loadGlossary() {
  const file = path.join(ROOT, "glossary.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function systemPrompt(lang) {
  const glossary = loadGlossary();
  const glossaryBlock = Object.keys(glossary).length
    ? "\nGlossary (must follow exactly):\n" +
      Object.entries(glossary)
        .map(([en, tr]) => `- "${en}" -> "${tr}"`)
        .join("\n")
    : "";
  const informal =
    lang.toLowerCase() === "ru_ru"
      ? ' Address the player informally ("ты", not "вы").'
      : "";
  return `You are a professional game localizer. Translate Minecraft modpack quest texts (FTB Quests) from English to ${langName(lang)}.

Rules:
- Preserve ALL markup and formatting EXACTLY as-is: Minecraft color/format codes (&a, &l, &r, §6 ...), FTB markup in curly braces ({image:...}, {@pagebreak}, {advancement:...}), Patchouli markup ($(l), $(item), $(br), $() ...), placeholders (%s, %d), item/block IDs (minecraft:stone, create:cogwheel), commands (/home), URLs, JSON snippets.
- Do NOT translate mod names and proper nouns (Create, Mekanism, Botania, Applied Energistics, Thermal, EMC, RF, FE etc.).
- Keep leading/trailing whitespace of each string.
- Keep the translation concise: quest UI has limited space. Natural gaming style.${informal}${glossaryBlock}

Input: a JSON array of strings. Output: ONLY a valid JSON array of translated strings with the SAME length and order. No commentary, no code fences.`;
}

export function cacheKey(lang, text) {
  return crypto.createHash("sha256").update(`${lang}\x00${text}`).digest("hex").slice(0, 32);
}

export function loadCache(lang) {
  const file = path.join(CACHE_DIR, `translations-${lang}.json`);
  if (fs.existsSync(file)) {
    try {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))));
    } catch {
      return new Map();
    }
  }
  return new Map();
}

function saveCache(lang, cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `translations-${lang}.json`);
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(cache)), "utf8");
}

function parseArrayResponse(content, expectedLen) {
  let s = content.trim();
  // срезаем code fences, если модель их всё же добавила
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("в ответе нет JSON-массива");
  const arr = JSON.parse(s.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error("ответ не массив");
  if (arr.length !== expectedLen) {
    throw new Error(`длина не совпала: ждали ${expectedLen}, получили ${arr.length}`);
  }
  for (const x of arr) if (typeof x !== "string") throw new Error("в массиве не только строки");
  return arr;
}

async function translateBatch(cfg, lang, texts, log) {
  const messages = [
    { role: "system", content: systemPrompt(lang) },
    { role: "user", content: JSON.stringify(texts) },
  ];
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const content = await chat(cfg, messages);
      return parseArrayResponse(content, texts.length);
    } catch (e) {
      lastErr = e;
      log(`  повтор ${attempt}/3: ${e.message.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  // батч не осилили целиком — делим пополам; единичный фейл помечаем null
  // (в результат пойдёт оригинал, но в кэш такое не пишем)
  if (texts.length > 1) {
    const mid = Math.ceil(texts.length / 2);
    const left = await translateBatch(cfg, lang, texts.slice(0, mid), log);
    const right = await translateBatch(cfg, lang, texts.slice(mid), log);
    return [...left, ...right];
  }
  log(`  НЕ ПЕРЕВЕДЕНО (оставляю оригинал): ${texts[0].slice(0, 80)}`);
  return [null];
}

export function makeBatches(items, maxItems, maxChars) {
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= maxItems || chars + it.text.length > maxChars)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += it.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// entries: [{ text, ... }] -> Map<text, перевод>. onProgress({done, total}).
export async function translateAll(cfg, lang, entries, { log = console.log, onProgress = () => {} } = {}) {
  const cache = loadCache(lang);
  const result = new Map();

  const uniqueTexts = [...new Set(entries.map((e) => e.text))];
  const pending = [];
  for (const text of uniqueTexts) {
    const cached = cache.get(cacheKey(lang, text));
    if (cached !== undefined) result.set(text, cached);
    else pending.push({ text });
  }

  const total = uniqueTexts.length;
  let done = total - pending.length;
  if (done) log(`Из кэша: ${done}/${total}`);
  onProgress({ done, total });

  const batches = makeBatches(pending, cfg.batchMaxItems, cfg.batchMaxChars);
  let batchIdx = 0;
  let sinceSave = 0;

  async function worker() {
    while (batchIdx < batches.length) {
      const batch = batches[batchIdx++];
      const texts = batch.map((b) => b.text);
      const translated = await translateBatch(cfg, lang, texts, log);
      for (let j = 0; j < texts.length; j++) {
        if (translated[j] === null) {
          result.set(texts[j], texts[j]); // фейл: оригинал в результат, мимо кэша
          continue;
        }
        result.set(texts[j], translated[j]);
        cache.set(cacheKey(lang, texts[j]), translated[j]);
      }
      done += texts.length;
      sinceSave++;
      if (sinceSave >= 5) {
        saveCache(lang, cache);
        sinceSave = 0;
      }
      log(`Переведено ${done}/${total}`);
      onProgress({ done, total });
    }
  }

  const workers = Array.from({ length: Math.min(cfg.concurrency, batches.length) }, worker);
  await Promise.all(workers);
  saveCache(lang, cache);
  return result;
}
