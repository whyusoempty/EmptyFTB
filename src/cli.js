#!/usr/bin/env node
// CLI: translate / models / ui
import { loadConfig, listModels } from "./api.js";
import { runJob } from "./job.js";
import { startServer } from "./server.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const HELP = `EmptyFTB quest translator — перевод квестов FTB Quests через vibecode.moe

Команды:
  eftb translate <путь> [--lang ru_ru] [--model <id>] [--out <папка>] [--dry]
      <путь> — корень сборки или config/ftbquests/quests
      --dry  — только посчитать строки, без перевода
  eftb models              список доступных моделей
  eftb ui [--port 3210]    мини-GUI в браузере

Ключ API: config.json (apiKey) или переменная VIBECODE_API_KEY.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === "help" || args.help) {
    console.log(HELP);
    return;
  }

  if (cmd === "models") {
    const cfg = loadConfig();
    const models = await listModels(cfg);
    console.log(models.join("\n") || "(пусто)");
    return;
  }

  if (cmd === "ui") {
    const cfg = loadConfig();
    const port = Number(args.port ?? 3210);
    await startServer(cfg, port);
    return;
  }

  if (cmd === "translate") {
    const input = args._[1];
    if (!input) {
      console.error("Укажи путь к сборке или папке квестов. См. eftb help");
      process.exit(1);
    }
    const cfg = loadConfig();
    if (args.model) cfg.model = args.model;
    const lang = (args.lang ?? "ru_ru").toLowerCase();
    await runJob({ input, lang, cfg, dry: !!args.dry, out: args.out });
    return;
  }

  console.error(`Неизвестная команда: ${cmd}\n\n${HELP}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`Ошибка: ${e.message}`);
  process.exit(1);
});
