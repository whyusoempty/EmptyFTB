// Прикидка расхода токенов на перевод — без реального вызова API.
// Точных цифр не бывает без токенизатора конкретной модели, но погрешность
// в пределах ~15% достаточна, чтобы прикинуть, во что обойдётся прогон.
//
// Константы откалиброваны по двум боевым прогонам (2026-07-02, claude-sonnet-5):
//   396 уникальных строк / 25503 симв -> факт 174k взвешенных токенов, оценка ~173k
//   2091 уникальная строка / 96963 симв -> факт 557k взвешенных токенов, оценка ~525k
import { systemPrompt, makeBatches, cacheKey, loadCache } from "./translate.js";
import { priceOf } from "./pricing.js";

const CHARS_PER_TOKEN_EN = 4; // исходный (английский) текст + служебный JSON
const CHARS_PER_TOKEN_RU = 2.3; // кириллица кодируется гораздо плотнее токенами
const JSON_OVERHEAD = 1.12; // кавычки/запятые/скобки массива
const RU_EXPANSION = 1.15; // русский текст обычно на ~15% длиннее английского

// entries: [{ text }], уже объединённые по всем юнитам сборки.
export function estimateTokens(lang, entries, cfg) {
  const cache = loadCache(lang);
  const uniqueTexts = [...new Set(entries.map((e) => e.text))];
  const pending = uniqueTexts.filter((t) => cache.get(cacheKey(lang, t)) === undefined);
  const cachedCount = uniqueTexts.length - pending.length;

  const batches = makeBatches(
    pending.map((text) => ({ text })),
    cfg.batchMaxItems,
    cfg.batchMaxChars
  );
  const sysChars = systemPrompt(lang).length;

  let inputTokens = 0;
  let outputTokens = 0;
  for (const batch of batches) {
    const chars = batch.reduce((n, b) => n + b.text.length, 0);
    inputTokens += sysChars / CHARS_PER_TOKEN_EN + (chars * JSON_OVERHEAD) / CHARS_PER_TOKEN_EN;
    outputTokens += (chars * RU_EXPANSION * JSON_OVERHEAD) / CHARS_PER_TOKEN_RU;
  }

  return {
    unique: uniqueTexts.length,
    cached: cachedCount,
    pending: pending.length,
    batches: batches.length,
    inputTokens: Math.round(inputTokens),
    outputTokens: Math.round(outputTokens),
  };
}

export function weightedCost(inputTokens, outputTokens, model) {
  const p = priceOf(model);
  if (!p) return null;
  return Math.round(inputTokens * p.in + outputTokens * p.out);
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return Math.round(n / 1000) + "k";
  return String(n);
}

// Модели для быстрого сравнения "а если взять подешевле" в dry-run.
const COMPARE_MODELS = [
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "gemini-3-flash-preview",
  "gpt-5.4-mini",
];

export function formatEstimate(lang, entries, cfg) {
  const est = estimateTokens(lang, entries, cfg);
  const lines = [];
  if (est.cached) lines.push(`Уже в кэше (бесплатно): ${est.cached}/${est.unique}`);
  if (!est.pending) {
    lines.push("Всё уже переведено и лежит в кэше — прогон ничего не будет стоить.");
    return lines.join("\n");
  }
  lines.push(
    `К переводу: ${est.pending} строк, ${est.batches} батчей, ~${fmt(est.inputTokens)} вход + ~${fmt(est.outputTokens)} выход "сырых" токенов`
  );

  const rows = [];
  const seen = new Set();
  for (const model of [cfg.model, ...COMPARE_MODELS]) {
    if (seen.has(model)) continue;
    seen.add(model);
    const cost = weightedCost(est.inputTokens, est.outputTokens, model);
    if (cost === null) continue;
    rows.push({ model, cost, current: model === cfg.model });
  }
  rows.sort((a, b) => a.cost - b.cost);
  lines.push("Оценка расхода (взвешенные токены баланса vibecode, ±15-20%):");
  for (const r of rows) {
    lines.push(`  ${r.current ? "→" : " "} ${r.model}: ~${fmt(r.cost)}`);
  }
  return lines.join("\n");
}
