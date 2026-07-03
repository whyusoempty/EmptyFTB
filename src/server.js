// Мини-GUI: локальный http-сервер без зависимостей. Одна задача за раз,
// прогресс уходит в браузер через SSE. Ключ по умолчанию живёт только в
// config.json на диске — в браузер он никогда не отправляется, только
// используется если юзер сам не ввёл свой ключ для другого провайдера.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { listModels } from "./api.js";
import { runJob } from "./job.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const job = {
  running: false,
  clients: new Set(),
  history: [],
};

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  job.history.push(msg);
  if (job.history.length > 2000) job.history.shift();
  for (const res of job.clients) res.write(msg);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

// Накладывает переданные из браузера оверрайды поверх серверного config.json.
// Пустые/отсутствующие поля не трогают дефолт — так что можно переопределить
// только модель или только ключ, не указывая остальное.
function mergeOverrides(base, body) {
  const cfg = { ...base };
  if (body.baseUrl) cfg.baseUrl = body.baseUrl.trim();
  if (body.apiKey) cfg.apiKey = body.apiKey.trim();
  if (body.apiFormat) cfg.apiFormat = body.apiFormat;
  if (body.model) cfg.model = body.model;
  if (body.batchMaxItems) cfg.batchMaxItems = Math.max(1, Number(body.batchMaxItems) || base.batchMaxItems);
  if (body.batchMaxChars) cfg.batchMaxChars = Math.max(100, Number(body.batchMaxChars) || base.batchMaxChars);
  return cfg;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function startServer(cfg, port = 3210) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(path.join(ROOT, "web", "index.html")));
        return;
      }

      // Безопасный срез конфига для прелоада формы — без apiKey.
      if (req.method === "GET" && url.pathname === "/api/config") {
        sendJson(res, 200, {
          baseUrl: cfg.baseUrl,
          apiFormat: cfg.apiFormat,
          model: cfg.model,
          batchMaxItems: cfg.batchMaxItems,
          batchMaxChars: cfg.batchMaxChars,
          hasKey: !!cfg.apiKey,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/models") {
        const body = await readBody(req);
        const lookupCfg = mergeOverrides(cfg, body);
        try {
          const models = await listModels(lookupCfg);
          sendJson(res, 200, { models, default: lookupCfg.model });
        } catch (e) {
          sendJson(res, 200, { models: [], default: lookupCfg.model, error: e.message });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        for (const msg of job.history) res.write(msg);
        job.clients.add(res);
        req.on("close", () => job.clients.delete(res));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/translate") {
        if (job.running) {
          sendJson(res, 409, { error: "Перевод уже идёт" });
          return;
        }
        const body = await readBody(req);
        if (!body.input) {
          sendJson(res, 400, { error: "Не указан путь" });
          return;
        }
        job.running = true;
        job.history = [];
        const jobCfg = mergeOverrides(cfg, body);
        sendJson(res, 200, { started: true });

        runJob({
          input: body.input,
          lang: (body.lang || "ru_ru").toLowerCase(),
          cfg: jobCfg,
          dry: !!body.dry,
          fresh: !!body.fresh,
          log: (line) => broadcast("log", { line }),
          onProgress: (p) => broadcast("progress", p),
        })
          .then((result) => broadcast("done", result))
          .catch((e) => broadcast("failed", { error: e.message }))
          .finally(() => {
            job.running = false;
          });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });

  const addr = `http://localhost:${port}`;
  return new Promise((resolve, reject) => {
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        // сервер уже где-то запущен (второй клик по ярлыку и т.п.) — не крашимся,
        // просто открываем браузер на уже работающий инстанс
        console.log(`Мини-GUI уже запущена на ${addr} — открываю вкладку`);
        if (process.platform === "win32") exec(`start "" "${addr}"`);
        resolve(null);
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`Мини-GUI: ${addr} (Ctrl+C чтобы остановить)`);
      if (process.platform === "win32") exec(`start "" "${addr}"`);
      resolve(server);
    });
  });
}
