// Оркестрация: найти в сборке всё переводимое (FTB Quests, KubeJS-ланги,
// книги Patchouli), извлечь строки, перевести одним прогоном, записать.
// Используется и CLI, и мини-GUI.
import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "./snbt.js";
import { extractInline, extractLang, applyAt, worthTranslating } from "./extract.js";
import { translateAll } from "./translate.js";
import { createZip } from "./zip.js";
import { formatEstimate } from "./estimate.js";

function exists(p) {
  return fs.existsSync(p);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// файлы в сборках бывают с BOM — срезаем перед парсингом
function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

// Сборки иногда содержат битые файлы (не JSON, не SNBT, обрезанные и т.п.) —
// одна кривая правка автора не должна валить перевод всей остальной сборки.
function tryReadJson(file, log) {
  try {
    return readJson(file);
  } catch (e) {
    log(`Пропускаю сломанный файл: ${e.message}`);
    return null;
  }
}

function tryParseSnbt(file, log) {
  try {
    return parse(readText(file));
  } catch (e) {
    log(`Пропускаю сломанный файл: ${file}: ${e.message}`);
    return null;
  }
}

function* walkFiles(dir, ext) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full, ext);
    else if (e.name.endsWith(ext)) yield full;
  }
}

// ---------- FTB Quests ----------

function findQuestsDir(root) {
  const candidates = [
    root,
    path.join(root, "quests"),
    path.join(root, "config", "ftbquests", "quests"),
  ];
  for (const c of candidates) {
    if (
      exists(path.join(c, "chapters")) ||
      exists(path.join(c, "lang")) ||
      exists(path.join(c, "data.snbt"))
    ) {
      return c;
    }
  }
  return null;
}

function collectInlineFiles(questsDir) {
  const files = [];
  const chapters = path.join(questsDir, "chapters");
  if (exists(chapters)) files.push(...walkFiles(chapters, ".snbt"));
  const rewardTables = path.join(questsDir, "reward_tables");
  if (exists(rewardTables)) files.push(...walkFiles(rewardTables, ".snbt"));
  for (const name of ["chapter_groups.snbt", "data.snbt"]) {
    const f = path.join(questsDir, name);
    if (exists(f)) files.push(f);
  }
  return files;
}

// Путь папки квестов внутри .minecraft — для записи в архив. Если юзер указал
// саму папку квестов (относительный путь не строится), берём каноничный.
function questsPackPrefix(root, questsDir) {
  const rel = path.relative(root, questsDir);
  if (!rel || rel.startsWith("..") || !rel.startsWith("config")) {
    return path.join("config", "ftbquests", "quests");
  }
  return rel;
}

function ftbqUnit(root, questsDir, lang, outOverride, log) {
  if (exists(path.join(questsDir, "lang", "en_us.snbt"))) {
    const file = path.join(questsDir, "lang", "en_us.snbt");
    const tree = tryParseSnbt(file, log);
    if (!tree) return null;
    const entries = extractLang(tree);
    return {
      label: "FTB Quests (новый формат, lang/en_us.snbt)",
      entries,
      apply(tr) {
        const outDir = outOverride ? path.resolve(outOverride) : path.join(questsDir, "lang");
        fs.mkdirSync(outDir, { recursive: true });
        for (const e of entries) applyAt(tree, e.path, tr.get(e.text) ?? e.text);
        const outFile = path.join(outDir, `${lang}.snbt`);
        fs.writeFileSync(outFile, stringify(tree) + "\n", "utf8");
        return [
          {
            file: outFile,
            packPath: path.join(questsPackPrefix(root, questsDir), "lang", `${lang}.snbt`),
          },
        ];
      },
    };
  }

  if (exists(path.join(questsDir, "chapters"))) {
    const files = collectInlineFiles(questsDir)
      .map((file) => {
        const tree = tryParseSnbt(file, log);
        return tree ? { file, tree, entries: extractInline(tree) } : null;
      })
      .filter(Boolean);
    const withText = files.filter((f) => f.entries.length);
    // Старый формат хранит текст прямо в файле — нет отдельного lang-файла,
    // который игра подхватила бы сама по выбранному языку. Единственный
    // способ увидеть перевод в игре — переписать сами файлы квестов.
    // По умолчанию делаем это на месте (с автобэкапом оригинала); --out
    // остаётся ручным способом вывести перевод в отдельную папку для обзора.
    const backupDir = `${questsDir}-backup-en-${timestamp()}`;
    return {
      label: "FTB Quests (старый формат, текст в chapters/*.snbt)",
      entries: withText.flatMap((f) => f.entries),
      apply(tr) {
        const written = [];
        if (outOverride) {
          const outDir = path.resolve(outOverride);
          for (const { file, tree, entries } of withText) {
            for (const e of entries) applyAt(tree, e.path, tr.get(e.text) ?? e.text);
            const rel = path.relative(questsDir, file);
            const outFile = path.join(outDir, rel);
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            fs.writeFileSync(outFile, stringify(tree) + "\n", "utf8");
            written.push({
              file: outFile,
              packPath: path.join(questsPackPrefix(root, questsDir), rel),
            });
          }
          return written;
        }
        for (const { file, tree, entries } of withText) {
          for (const e of entries) applyAt(tree, e.path, tr.get(e.text) ?? e.text);
          const rel = path.relative(questsDir, file);
          const backupFile = path.join(backupDir, rel);
          fs.mkdirSync(path.dirname(backupFile), { recursive: true });
          fs.copyFileSync(file, backupFile); // оригинал (английский) — до перезаписи
          fs.writeFileSync(file, stringify(tree) + "\n", "utf8");
          written.push({
            file,
            packPath: path.join(questsPackPrefix(root, questsDir), rel),
          });
        }
        return written;
      },
      note: outOverride
        ? "Скопируй содержимое поверх оригинальной папки quests (бэкап оригинала сделай сам)."
        : `Квесты переписаны на месте — игра подхватит перевод сразу. Оригинал (английский) сохранён в ${backupDir}.`,
    };
  }

  return null;
}

// ---------- KubeJS lang (kubejs/assets/<ns>/lang/en_us.json) ----------

function extractJsonValues(node, pathAcc, entries, keyFilter = null) {
  if (typeof node === "string") {
    if (worthTranslating(node)) entries.push({ path: pathAcc, text: node });
  } else if (Array.isArray(node)) {
    node.forEach((v, idx) => extractJsonValues(v, [...pathAcc, idx], entries, keyFilter));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (keyFilter && typeof v === "string" && !keyFilter.has(k)) continue;
      extractJsonValues(v, [...pathAcc, k], entries, keyFilter);
    }
  }
}

function kubejsUnits(root, lang, log) {
  const assets = path.join(root, "kubejs", "assets");
  if (!exists(assets)) return [];
  const units = [];
  for (const ns of fs.readdirSync(assets, { withFileTypes: true })) {
    if (!ns.isDirectory()) continue;
    const enFile = path.join(assets, ns.name, "lang", "en_us.json");
    if (!exists(enFile)) continue;
    const json = tryReadJson(enFile, log);
    if (!json) continue;
    const entries = [];
    extractJsonValues(json, [], entries);
    units.push({
      label: `KubeJS lang: kubejs/assets/${ns.name}/lang/en_us.json`,
      entries,
      apply(tr) {
        for (const e of entries) applyAt(json, e.path, tr.get(e.text) ?? e.text);
        const outFile = path.join(assets, ns.name, "lang", `${lang}.json`);
        fs.writeFileSync(outFile, JSON.stringify(json, null, 2) + "\n", "utf8");
        return [{ file: outFile, packPath: path.relative(root, outFile) }];
      },
    });
  }
  return units;
}

// В скриптах KubeJS текст бывает захардкожен (Text.of, displayName и т.п.) —
// автоматически такое не правим, но предупредим, что оно есть.
function kubejsScriptWarning(root, log) {
  const dirs = ["client_scripts", "startup_scripts", "server_scripts"].map((d) =>
    path.join(root, "kubejs", d)
  );
  let hits = 0;
  for (const dir of dirs) {
    if (!exists(dir)) continue;
    for (const file of walkFiles(dir, ".js")) {
      const src = fs.readFileSync(file, "utf8");
      const m = src.match(/\.(displayName|tooltip)\s*\(\s*["'`][^"'`]*[A-Za-z]{3,}/g);
      if (m) hits += m.length;
    }
  }
  if (hits) {
    log(
      `Внимание: в kubejs-скриптах найдено ~${hits} захардкоженных строк (displayName/tooltip) — их автоматом не переводим, лучше вынести в lang-файл.`
    );
  }
}

// ---------- Patchouli books ----------

const PATCHOULI_KEYS = new Set([
  "name",
  "description",
  "landing_text",
  "subtitle",
  "title",
  "text",
]);

function patchouliUnits(root, lang, log) {
  const units = [];
  const bookRoots = [path.join(root, "patchouli_books"), path.join(root, "config", "patchouli_books")];
  for (const bookRoot of bookRoots) {
    if (!exists(bookRoot)) continue;
    for (const book of fs.readdirSync(bookRoot, { withFileTypes: true })) {
      if (!book.isDirectory()) continue;
      const enDir = path.join(bookRoot, book.name, "en_us");
      if (!exists(enDir)) continue;
      const files = [...walkFiles(enDir, ".json")]
        .map((file) => {
          const json = tryReadJson(file, log);
          if (!json) return null;
          const entries = [];
          extractJsonValues(json, [], entries, PATCHOULI_KEYS);
          return { file, json, entries };
        })
        .filter(Boolean);
      const withText = files.filter((f) => f.entries.length);
      if (!withText.length) continue;
      units.push({
        label: `Patchouli: ${path.relative(root, path.join(bookRoot, book.name))} (${withText.length} файлов)`,
        entries: withText.flatMap((f) => f.entries),
        apply(tr) {
          const outDir = path.join(bookRoot, book.name, lang);
          const written = [];
          for (const { file, json, entries } of withText) {
            for (const e of entries) applyAt(json, e.path, tr.get(e.text) ?? e.text);
            const outFile = path.join(outDir, path.relative(enDir, file));
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            fs.writeFileSync(outFile, JSON.stringify(json, null, 2) + "\n", "utf8");
            written.push({ file: outFile, packPath: path.relative(root, outFile) });
          }
          return written;
        },
      });
    }
  }
  return units;
}

// ---------- запуск ----------

export async function runJob({ input, lang, cfg, dry = false, out, fresh = false, log = console.log, onProgress }) {
  const root = path.resolve(input);
  if (!exists(root)) throw new Error(`Папка не найдена: ${root}`);
  lang = lang.toLowerCase();

  const units = [];
  const questsDir = findQuestsDir(root);
  if (questsDir) {
    const u = ftbqUnit(root, questsDir, lang, out, log);
    if (u) units.push(u);
  }
  units.push(...kubejsUnits(root, lang, log));
  units.push(...patchouliUnits(root, lang, log));
  kubejsScriptWarning(root, log);

  if (!units.length) {
    throw new Error(
      `Не нашёл ничего переводимого в ${root} (ищу квесты FTB, kubejs/assets/*/lang/en_us.json, patchouli_books)`
    );
  }

  let totalChars = 0;
  for (const u of units) {
    const uniq = new Set(u.entries.map((e) => e.text));
    const chars = [...uniq].reduce((n, t) => n + t.length, 0);
    totalChars += chars;
    log(`${u.label}: ${u.entries.length} строк (~${chars} символов)`);
  }
  const allEntries = units.flatMap((u) => u.entries);
  const uniq = new Set(allEntries.map((e) => e.text));
  log(`Всего: ${allEntries.length} строк, уникальных ${uniq.size}, ~${totalChars} символов`);

  if (dry) {
    log(formatEstimate(lang, allEntries, cfg));
    log("Dry-run: перевод не запускаю.");
    return { units: units.length, entries: allEntries.length, unique: uniq.size, chars: totalChars };
  }
  if (!allEntries.length) {
    log("Переводить нечего.");
    return { units: units.length, entries: 0 };
  }

  const translations = await translateAll(cfg, lang, allEntries, { log, onProgress, fresh });

  const written = [];
  let outDir = null;
  for (const u of units) {
    const files = u.apply(translations);
    written.push(...files);
    if (!outDir && files.length) outDir = path.dirname(files[0].file);
    if (u.note) log(u.note);
  }

  log(`Готово. Записано файлов: ${written.length}`);
  for (const w of written.slice(0, 20)) log(`  ${w.file}`);
  if (written.length > 20) log(`  ... и ещё ${written.length - 20}`);

  // архив для друзей: пути внутри zip — относительно .minecraft,
  // распаковал в свою сборку — и всё на месте
  let zipFile = null;
  if (written.length) {
    zipFile = path.join(root, `translation-${lang}.zip`);
    const zip = createZip(
      written.map((w) => ({ name: w.packPath, data: fs.readFileSync(w.file) }))
    );
    fs.writeFileSync(zipFile, zip);
    log(`Архив для друзей: ${zipFile} (распаковать в .minecraft сборки)`);
  }

  return { units: units.length, outDir, written: written.length, zipFile };
}
