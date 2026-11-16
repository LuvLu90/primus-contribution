// 技能文件（SKILL.md）frontmatter 的解析与校验（ADR 0017），规则与 Core 一致：
// - frontmatter：去掉 BOM、换行统一为 \n 后以 `---` 开头，到下一个 `\n---` 为止；没有时视为空。
// - 缺少 description（或为空白）的技能 Core 不加载：阻止安装。
// - name 缺省时用技能目录名；名称（小写字母、数字、连字符，最长 64，不以连字符开头或结尾、不含连续连字符）与
//   description 长度（最长 1024）的问题 Core 只告警，照常加载：这里同样只提示。
// Core 用完整的 YAML 解析器；这里实现常见写法的子集（顶层键值、引号字符串、块标量 | 与 >、多行普通标量、
// 嵌套的映射 / 列表只跳过）。遇到 Core 会报错的写法（普通标量里的 `: `、重复的键、制表符缩进）同样报错；
// 少数 Core 能接受而这里不认识的写法会被拒绝（宁可不装，也不装一个 Core 读不出描述的技能）。

import { strings } from "@/lib/strings";
import { fill } from "./ui";

const msg = strings.capabilityChecks.skill;

export interface SkillCheck {
  /** 生效的名称：frontmatter 的 name，缺省为目录名 */
  name: string;
  description: string | null;
  /** 阻止安装的问题（Core 不会加载） */
  errors: string[];
  /** 只告警的问题（Core 仍会加载） */
  warnings: string[];
}

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;

/** 取出 frontmatter 的 YAML 文本；没有时为 null */
export function extractFrontmatter(content: string): string | null {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return null;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return null;
  return normalized.slice(4, end);
}

class YamlError extends Error {}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** 普通标量的类型：布尔、null、数字，其余为字符串 */
function plainValue(text: string): unknown {
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (text === "" || /^(null|Null|NULL|~)$/.test(text)) return null;
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  return text;
}

function doubleQuoted(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = body[++i];
    const map: Record<string, string> = {
      n: "\n",
      t: "\t",
      r: "\r",
      '"': '"',
      "\\": "\\",
      "/": "/",
      "0": "\0",
      " ": " ",
    };
    if (n !== undefined && n in map) out += map[n];
    else if (n === "u" || n === "x" || n === "U") {
      const len = n === "x" ? 2 : n === "u" ? 4 : 8;
      const hex = body.slice(i + 1, i + 1 + len);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new YamlError(msg.yamlEscape);
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i += len;
    } else throw new YamlError(msg.yamlEscape);
  }
  return out;
}

/** 块标量（| 或 >）：收集缩进更深的行 */
function blockScalar(header: string, lines: string[], start: number): [string, number] {
  const m = /^([|>])([-+]?)(\d?)([-+]?)\s*(#.*)?$/.exec(header);
  if (!m) throw new YamlError(msg.yamlBlock);
  const folded = m[1] === ">";
  const chomp = m[2] || m[4];
  const body: string[] = [];
  let i = start;
  let indent = m[3] ? Number(m[3]) : 0;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const ind = indentOf(line);
    if (indent === 0) indent = ind;
    if (ind < indent || ind === 0) break;
    body.push(line.slice(indent));
  }
  // 末尾空行属于换行处理
  let trailing = 0;
  while (body.length && body[body.length - 1] === "") {
    body.pop();
    trailing++;
  }
  let text: string;
  if (folded) {
    text = "";
    body.forEach((l, idx) => {
      if (idx === 0) text = l;
      else if (l === "") text += "\n";
      else if (body[idx - 1] === "" || /^\s/.test(l) || /^\s/.test(body[idx - 1] ?? ""))
        text += (text.endsWith("\n") ? "" : "\n") + l;
      else text += ` ${l}`;
    });
  } else text = body.join("\n");
  if (body.length === 0) text = "";
  else if (chomp === "-") {
    /* 去掉末尾换行 */
  } else if (chomp === "+") text += "\n".repeat(Math.max(trailing, 1));
  else text += "\n";
  return [text, i - trailing];
}

/**
 * 解析 frontmatter 的顶层映射（YAML 子集）。嵌套的映射、列表与流式集合不展开，值记为对象。
 * 解析不了时抛出 Error（与 Core 一样视为无法读取）。
 */
export function parseYamlSubset(yaml: string): Record<string, unknown> {
  const lines = yaml.split("\n");
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (/^\s*(#.*)?$/.test(line)) {
      i++;
      continue;
    }
    if (/^\t/.test(line)) throw new YamlError(msg.yamlTab);
    if (indentOf(line) > 0) throw new YamlError(fill(msg.yamlIndent, { line: i + 1 }));
    if (line.startsWith("---") || line.startsWith("...")) throw new YamlError(msg.yamlDocuments);
    const m =
      /^("(?:[^"\\]|\\.)*"\s*|'(?:[^']|'')*'\s*|[^\s:#'"[\]{},&*!|>%@`-][^:#]*|-[^\s:][^:#]*):(?:\s+(.*))?$/.exec(
        line,
      );
    if (!m?.[1]) throw new YamlError(fill(msg.yamlPair, { line: i + 1 }));
    let key = m[1].trimEnd();
    if (key.startsWith('"')) key = doubleQuoted(key.slice(1, -1));
    else if (key.startsWith("'")) key = key.slice(1, -1).replace(/''/g, "'");
    key = key.trim();
    if (Object.hasOwn(out, key)) throw new YamlError(fill(msg.yamlDuplicate, { key }));
    const rest = (m[2] ?? "").trim();
    i++;
    if (rest === "" || rest.startsWith("#")) {
      // 嵌套的映射或列表：跳过缩进的行（或紧跟的 `- ` 列表项）
      let nested = false;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (l.trim() === "" || /^\s+#/.test(l)) {
          i++;
          continue;
        }
        if (/^\t/.test(l)) throw new YamlError(msg.yamlTab);
        if (indentOf(l) > 0 || /^- /.test(l) || l === "-") {
          nested = true;
          i++;
          continue;
        }
        break;
      }
      out[key] = nested ? {} : null;
      continue;
    }
    if (rest.startsWith("|") || rest.startsWith(">")) {
      const [text, next] = blockScalar(rest, lines, i);
      out[key] = text;
      i = next;
      continue;
    }
    if (rest.startsWith('"')) {
      const q = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(rest);
      if (!q) throw new YamlError(fill(msg.yamlQuote, { key }));
      out[key] = doubleQuoted(q[1] ?? "");
      continue;
    }
    if (rest.startsWith("'")) {
      const q = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(rest);
      if (!q) throw new YamlError(fill(msg.yamlQuote, { key }));
      out[key] = (q[1] ?? "").replace(/''/g, "'");
      continue;
    }
    if (rest.startsWith("[") || rest.startsWith("{")) {
      out[key] = rest.startsWith("[") ? [] : {};
      continue;
    }
    if (/^[&*!%@`]/.test(rest)) throw new YamlError(fill(msg.yamlValue, { key }));
    // 普通标量：去掉行尾注释，可以跨行（缩进的续行用空格连接）
    let text = stripComment(rest);
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "") {
        // 空行后还有缩进的续行：空行变成换行
        const next = lines.slice(i).findIndex((x) => x.trim() !== "");
        const nl = next === -1 ? undefined : lines[i + next];
        if (nl !== undefined && indentOf(nl) > 0) {
          text += "\n";
          i += next;
          continue;
        }
        break;
      }
      if (indentOf(l) === 0) break;
      if (/^\s+#/.test(l)) break;
      text += `${text.endsWith("\n") ? "" : " "}${stripComment(l.trim())}`;
      i++;
    }
    if (/:\s|:$/.test(text)) throw new YamlError(fill(msg.yamlColon, { key }));
    out[key] = plainValue(text.trim());
  }
  return out;
}

/**
 * 去掉普通标量的行尾注释（空白后的 `#` 起）。不用 `/\s+#.*$/` 替换：长空白串上未锚定的匹配会反复回退，
 * 耗时随长度平方增长，来源不可信的技能文件能借此卡住界面
 */
function stripComment(text: string): string {
  const at = text.search(/\s#/);
  return at < 0 ? text : text.slice(0, at).trimEnd();
}

/** 名称规则（Core 的 validateName，只告警） */
export function nameWarnings(name: string): string[] {
  const w: string[] = [];
  if (name.length > MAX_NAME_LENGTH) w.push(fill(msg.nameLength, { n: MAX_NAME_LENGTH }));
  if (!/^[a-z0-9-]+$/.test(name)) w.push(msg.nameChars);
  if (name.startsWith("-") || name.endsWith("-")) w.push(msg.nameHyphenEdge);
  if (name.includes("--")) w.push(msg.nameHyphenRun);
  return w;
}

/** 校验技能文件：`dirName` 是技能目录名（name 缺省时 Core 用它） */
export function checkSkill(content: string, dirName: string): SkillCheck {
  const yaml = extractFrontmatter(content);
  let data: Record<string, unknown> = {};
  if (yaml !== null) {
    try {
      data = parseYamlSubset(yaml);
    } catch (e) {
      return {
        name: dirName,
        description: null,
        errors: [fill(msg.frontmatter, { message: e instanceof Error ? e.message : String(e) })],
        warnings: [],
      };
    }
  }
  const name = typeof data.name === "string" && data.name ? data.name : dirName;
  const description = typeof data.description === "string" ? data.description : null;
  const errors: string[] = [];
  const warnings = nameWarnings(name);
  if (description === null || description.trim() === "") errors.push(msg.noDescription);
  else if (description.length > MAX_DESCRIPTION_LENGTH)
    warnings.push(fill(msg.descriptionLength, { n: MAX_DESCRIPTION_LENGTH }));
  return { name, description, errors, warnings };
}

/** 安装目录名的建议：取名称里允许的字符（字母、数字、-、_、.），不以点开头，最多 64 个字符 */
export function suggestDirName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^\.+/, "")
    .slice(0, MAX_NAME_LENGTH);
}

/** 与薄壳一致的安装目录名校验 */
export function validDirName(name: string): boolean {
  return (
    /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name) &&
    !/\.$/.test(name) &&
    !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)
  );
}
