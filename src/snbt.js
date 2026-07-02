// Парсер/сериализатор SNBT в диалекте FTB Quests.
// FTB пишет файлы без запятых (разделитель — перенос строки), ключи без кавычек,
// числа с суффиксами (1b, 2.5f, 10L), плюс типизированные массивы [I; 1, 2].
// Нестроковые скаляры храним как Raw, чтобы round-trip был без потерь.

export class Raw {
  constructor(token) {
    this.token = token;
  }
}

export function parse(text) {
  let i = 0;

  const err = (msg) => {
    const ctx = text.slice(Math.max(0, i - 60), i + 60).replace(/\n/g, "\\n");
    throw new Error(`SNBT: ${msg} (позиция ${i}): ...${ctx}...`);
  };

  const ws = () => {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
  };

  function value() {
    ws();
    const c = text[i];
    if (c === "{") return compound();
    if (c === "[") return list();
    if (c === '"' || c === "'") return str(c);
    return literal();
  }

  function compound() {
    i++; // {
    const obj = {};
    ws();
    while (i < text.length && text[i] !== "}") {
      const k = key();
      ws();
      if (text[i] !== ":") err("ожидалось ':'");
      i++;
      obj[k] = value();
      ws();
    }
    if (text[i] !== "}") err("не закрыт compound");
    i++;
    return obj;
  }

  function key() {
    ws();
    if (text[i] === '"' || text[i] === "'") return str(text[i]);
    const s = i;
    while (i < text.length && /[A-Za-z0-9_.+*\-]/.test(text[i])) i++;
    if (s === i) err("ожидался ключ");
    return text.slice(s, i);
  }

  function list() {
    i++; // [
    ws();
    let typed = null;
    const m = /^([BILbil]);/.exec(text.slice(i, i + 2));
    if (m) {
      typed = m[1];
      i += 2;
    }
    const arr = [];
    ws();
    while (i < text.length && text[i] !== "]") {
      arr.push(value());
      ws();
    }
    if (text[i] !== "]") err("не закрыт список");
    i++;
    return typed ? { __typed: typed, values: arr } : arr;
  }

  function str(q) {
    i++; // открывающая кавычка
    let out = "";
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        const n = text[i + 1];
        if (n === "n") out += "\n";
        else if (n === "t") out += "\t";
        else if (n === "r") out += "\r";
        else if (n === "b") out += "\b";
        else if (n === "f") out += "\f";
        else if (n === "u") {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 4;
        } else out += n; // \", \', \\ и неизвестные — берём символ как есть
        i += 2;
      } else if (c === q) {
        i++;
        return out;
      } else {
        out += c;
        i++;
      }
    }
    err("не закрыта строка");
  }

  function literal() {
    const s = i;
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    if (s === i) err("ожидалось значение");
    return new Raw(text.slice(s, i));
  }

  const v = value();
  ws();
  if (i < text.length) err("лишние данные после корневого значения");
  return v;
}

function quote(s) {
  return (
    '"' +
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")
      .replace(/\r/g, "\\r") +
    '"'
  );
}

function keyStr(k) {
  return /^[A-Za-z0-9_.+\-]+$/.test(k) ? k : quote(k);
}

export function stringify(v, indent = 0) {
  const tab = "\t".repeat(indent);
  const tab1 = "\t".repeat(indent + 1);

  if (v instanceof Raw) return v.token;
  if (typeof v === "string") return quote(v);

  if (Array.isArray(v)) {
    if (v.length === 0) return "[ ]";
    const items = v.map((x) => tab1 + stringify(x, indent + 1));
    return "[\n" + items.join("\n") + "\n" + tab + "]";
  }

  if (v && typeof v === "object" && v.__typed) {
    const items = v.values.map((x) => stringify(x, 0)).join(", ");
    return `[${v.__typed}; ${items}]`;
  }

  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 0) return "{ }";
    const lines = keys.map((k) => `${tab1}${keyStr(k)}: ${stringify(v[k], indent + 1)}`);
    return "{\n" + lines.join("\n") + "\n" + tab + "}";
  }

  throw new Error(`SNBT: неизвестный тип значения: ${typeof v}`);
}
