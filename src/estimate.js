// Прикидка расхода токенов на перевод — без реального вызова API.
// Точных цифр не бывает без токенизатора конкретной модели, но погрешность
// в пределах ~15-20% достаточна, чтобы прикинуть объём запроса. Дальше
// сопоставляй эти числа с тарифом своего провайдера самостоятельно — у
// каждого он свой (доллары за токен, «баланс» и т.п.).
//
// Константы откалиброваны по двум боевым прогонам на claude-sonnet-5:
//   396 уникальных строк / 25503 симв
//   2091 уникальная строка / 96963 симв
import { systemPrompt, makeBatches, cacheKey, loadCache } from "./translate.js";

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

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return Math.round(n / 1000) + "k";
  return String(n);
}

export function formatEstimate(lang, entries, cfg) {
  const est = estimateTokens(lang, entries, cfg);
  const lines = [];
  if (est.cached) lines.push(`Уже в кэше (бесплатно): ${est.cached}/${est.unique}`);
  if (!est.pending) {
    lines.push("Всё уже переведено и лежит в кэше — прогон ничего не будет стоить.");
    return lines.join("\n");
  }
  lines.push(
    `К переводу: ${est.pending} строк, ${est.batches} батчей, ~${fmt(est.inputTokens)} вход + ~${fmt(est.outputTokens)} выход токенов (±15-20%, модель ${cfg.model})`
  );
  lines.push("Сопоставь это со своим тарифом провайдера, чтобы прикинуть цену.");
  return lines.join("\n");
}
