// Извлечение переводимых строк из дерева SNBT и запись переводов обратно.
import { Raw } from "./snbt.js";

// Ключи с текстом для игрока в старом (inline) формате квестов.
const TRANSLATABLE_KEYS = new Set(["title", "subtitle", "description"]);

// Строка стоит перевода, только если в ней есть латинские буквы
// (пустые строки, чистая разметка вида "{image:...}" и уже переведённое — мимо).
export function worthTranslating(s) {
  if (!/[A-Za-z]/.test(s)) return false;
  // строки, целиком состоящие из FTB-разметки без слов снаружи
  const stripped = s.replace(/\{[^}]*\}/g, "").replace(/&[0-9a-fk-or]/gi, "");
  return /[A-Za-z]/.test(stripped);
}

function isPlainObject(v) {
  return v && typeof v === "object" && !(v instanceof Raw) && !Array.isArray(v) && !v.__typed;
}

// Старый формат: собираем title/subtitle/description по всему дереву.
// entry = { path: [ключи и индексы], text }
export function extractInline(root) {
  const entries = [];

  function collect(v, path) {
    if (typeof v === "string") {
      if (worthTranslating(v)) entries.push({ path, text: v });
    } else if (Array.isArray(v)) {
      v.forEach((x, idx) => {
        if (typeof x === "string" && worthTranslating(x)) {
          entries.push({ path: [...path, idx], text: x });
        }
      });
    }
  }

  function walk(node, path) {
    if (Array.isArray(node)) {
      node.forEach((v, idx) => walk(v, [...path, idx]));
    } else if (isPlainObject(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (TRANSLATABLE_KEYS.has(k)) collect(v, [...path, k]);
        else walk(v, [...path, k]);
      }
    }
  }

  walk(root, []);
  return entries;
}

// Новый lang-формат (quests/lang/en_us.snbt): переводим ВСЕ строковые значения.
export function extractLang(root) {
  const entries = [];

  function walk(node, path) {
    if (typeof node === "string") {
      if (worthTranslating(node)) entries.push({ path, text: node });
    } else if (Array.isArray(node)) {
      node.forEach((v, idx) => walk(v, [...path, idx]));
    } else if (isPlainObject(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    }
  }

  walk(root, []);
  return entries;
}

export function applyAt(root, path, value) {
  let node = root;
  for (let j = 0; j < path.length - 1; j++) node = node[path[j]];
  node[path[path.length - 1]] = value;
}
