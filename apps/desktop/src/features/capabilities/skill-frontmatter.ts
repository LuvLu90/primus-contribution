// 技能文件（SKILL.md）frontmatter 的解析与校验（ADR 0017），与 Core 一致：
// - frontmatter 的取法逐行照搬 agent-core `packages/coding-agent/src/utils/frontmatter.ts`：去掉开头的 BOM、
//   换行统一为 \n 后以 `---` 开头，到下一个 `\n---` 为止；没有时视为空。YAML 用 Core 同一个解析器
//   （`yaml` 包，版本与 agent-core 锁定的一致）的 `parse`，默认选项，解析失败时 Core 不加载这个技能。
// - 校验照搬 agent-core `packages/coding-agent/src/core/skills.ts` 的 loadSkillFromFile：description 不是字符串
//   或为空白时 Core 不加载；name 缺省（或不是非空字符串）时用技能目录名；名称（小写字母、数字、连字符，最长 64，
//   不以连字符开头或结尾、不含连续连字符）与 description 长度（最长 1024）的问题 Core 只告警，照常加载。

import { parse } from "yaml";
import { strings } from "@/lib/strings";
import { fill } from "./ui";

const msg = strings.capabilityChecks.skill;

export interface SkillCheck {
  /** 生效的名称：frontmatter 的 name，缺省为目录名 */
  name: string;
  description: string | null;
  /** Core 不会加载这个技能的原因 */
  errors: string[];
  /** 只告警的问题（Core 仍会加载） */
  warnings: string[];
}

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;

const normalizeNewlines = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/** 与 Core 的 stripBom 一致：只去掉开头的一个 BOM */
const stripBom = (value: string): string =>
  value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;

/** 取出 frontmatter 的 YAML 文本；没有时为 null（Core 的 extractFrontmatter） */
export function extractFrontmatter(content: string): string | null {
  const normalized = normalizeNewlines(stripBom(content));
  if (!normalized.startsWith("---")) return null;
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return null;
  return normalized.slice(4, endIndex);
}

/** 解析 frontmatter（Core 的 parseFrontmatter）：没有时为空对象；YAML 无效时抛出解析器的错误 */
export function parseFrontmatter(content: string): unknown {
  const yamlString = extractFrontmatter(content);
  if (!yamlString) return {};
  return parse(yamlString) ?? {};
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

/** 读对象上的字段；frontmatter 可能是字符串、数组等任意 YAML 值，与 Core 的 `frontmatter.x` 一样取不到即 undefined */
function field(data: unknown, key: string): unknown {
  return data !== null && typeof data === "object"
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

/** 校验技能文件：`dirName` 是技能文件所在目录的名字（name 缺省时 Core 用它） */
export function checkSkill(content: string, dirName: string): SkillCheck {
  let data: unknown;
  try {
    data = parseFrontmatter(content);
  } catch (e) {
    return {
      name: dirName,
      description: null,
      errors: [fill(msg.frontmatter, { message: e instanceof Error ? e.message : String(e) })],
      warnings: [],
    };
  }
  const rawName = field(data, "name");
  const name = typeof rawName === "string" && rawName ? rawName : dirName;
  const rawDescription = field(data, "description");
  const description = typeof rawDescription === "string" ? rawDescription : null;
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
