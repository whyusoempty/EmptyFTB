// Множители стоимости токенов из https://vibecode.moe/instructions (таблица
// "Доступные модели"). in/out — во сколько раз модель дороже базовой ставки
// (×1) на вход/выход. Обновляй руками, если у них поменяются цены.
export const PRICING = {
  "gpt-5.5": { in: 2, out: 12 },
  "gpt-5.4": { in: 1, out: 6 },
  "gpt-5.4-mini": { in: 0.3, out: 1.8 },
  "claude-haiku-4-5": { in: 0.6, out: 3 },
  "claude-sonnet-4-6": { in: 1.8, out: 9 },
  "claude-sonnet-5": { in: 1.8, out: 9 },
  "claude-opus-4-6": { in: 3, out: 15 },
  "claude-opus-4-7": { in: 3, out: 15 },
  "claude-opus-4-8": { in: 3, out: 15 },
  "glm-5.2": { in: 2, out: 7 },
  "gemini-3-flash-preview": { in: 0.6, out: 3.6 },
  "gemini-3.1-pro-preview": { in: 2.4, out: 14.4 },
};

export function priceOf(model) {
  return PRICING[model] ?? null;
}
