// Клиент для любого OpenAI- или Anthropic-совместимого API
// (vibecode.moe по умолчанию, но подходит OpenAI, Anthropic, OpenRouter,
// локальный Ollama/LM Studio — что угодно с /chat/completions или /messages).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  baseUrl: "https://vibecode.moe/v1",
  apiKey: "",
  apiFormat: "auto", // "auto" | "openai" | "anthropic"
  model: "claude-sonnet-5",
  temperature: 0.3,
  concurrency: 3,
  batchMaxItems: 30,
  batchMaxChars: 4000,
};

export function loadConfig() {
  const cfg = { ...DEFAULTS };
  const file = path.join(ROOT, "config.json");
  if (fs.existsSync(file)) {
    Object.assign(cfg, JSON.parse(fs.readFileSync(file, "utf8")));
  }
  if (process.env.API_KEY) cfg.apiKey = process.env.API_KEY;
  else if (process.env.VIBECODE_API_KEY) cfg.apiKey = process.env.VIBECODE_API_KEY;
  if (!cfg.apiKey) {
    throw new Error(
      "Нет API-ключа: положи его в config.json (поле apiKey) или в переменную API_KEY"
    );
  }
  return cfg;
}

// "auto" угадывает по имени модели: у vibecode (и у самого Anthropic) клоды
// живут только на /v1/messages, всё остальное — на /chat/completions.
// Явно задать apiFormat нужно, если провайдер называет модели иначе
// (например прокси/локальный сервер с anthropic-style API под другим именем).
function resolveFormat(cfg) {
  if (cfg.apiFormat === "openai" || cfg.apiFormat === "anthropic") return cfg.apiFormat;
  return /^claude/i.test(cfg.model) ? "anthropic" : "openai";
}

async function chatOpenAI(cfg, messages, signal) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: cfg.temperature,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`API: неожиданный ответ: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return content;
}

async function chatAnthropic(cfg, messages, signal) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const res = await fetch(`${cfg.baseUrl}/messages`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 8192,
      temperature: cfg.temperature,
      ...(system ? { system } : {}),
      messages: rest,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const content = (data?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!content) {
    throw new Error(`API: неожиданный ответ: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return content;
}

export async function chat(cfg, messages, { signal } = {}) {
  return resolveFormat(cfg) === "anthropic"
    ? chatAnthropic(cfg, messages, signal)
    : chatOpenAI(cfg, messages, signal);
}

export async function listModels(cfg) {
  const anthropic = resolveFormat(cfg) === "anthropic";
  const headers = anthropic
    ? { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${cfg.apiKey}` };
  const res = await fetch(`${cfg.baseUrl}/models`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  return (data.data ?? data.models ?? []).map((m) => m.id ?? m.name ?? String(m));
}
