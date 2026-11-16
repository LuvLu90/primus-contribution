import { describe, expect, it } from "vitest";
import {
  checkSkill,
  extractFrontmatter,
  parseYamlSubset,
  suggestDirName,
  validDirName,
} from "./skill-frontmatter";

/**
 * 与 Core 所用的 YAML 解析器（agent-core 依赖的 yaml 包）逐例核对过的结果：[frontmatter, 期望]，
 * 期望为 null 表示 Core 解析失败。name / description / disable-model-invocation 以外的键不比较。
 */
const CASES: [string, { name?: unknown; description?: unknown; d?: unknown } | null][] = [
  [
    "name: pdf\ndescription: Extract text from PDFs",
    {
      name: "pdf",
      description: "Extract text from PDFs",
      d: null,
    },
  ],
  [
    "name: \"pdf\"\ndescription: 'It''s good'",
    {
      name: "pdf",
      description: "It's good",
      d: null,
    },
  ],
  [
    "description: |\n  line one\n  line two\nname: x",
    {
      name: "x",
      description: "line one\nline two\n",
      d: null,
    },
  ],
  [
    "description: >\n  folded one\n  folded two\n\n  para\n",
    {
      name: null,
      description: "folded one folded two\npara\n",
      d: null,
    },
  ],
  [
    "description: >-\n  a\n  b\n",
    {
      name: null,
      description: "a b",
      d: null,
    },
  ],
  [
    "description: |+\n  keep\n\n",
    {
      name: null,
      description: "keep\n\n",
      d: null,
    },
  ],
  ["description: Use this: for x", null],
  [
    "description: a\n  continued here\n  and here",
    {
      name: null,
      description: "a continued here and here",
      d: null,
    },
  ],
  ["name: a\nname: b\ndescription: d", null],
  [
    'description: "esc \\u00e9 \\n ok"',
    {
      name: null,
      description: "esc é \n ok",
      d: null,
    },
  ],
  [
    "description: x # comment\nname: y",
    {
      name: "y",
      description: "x",
      d: null,
    },
  ],
  [
    "metadata:\n  author: me\n  version: 1\ndescription: d",
    {
      name: null,
      description: "d",
      d: null,
    },
  ],
  [
    "allowed-tools:\n  - Read\n  - Bash\ndescription: d",
    {
      name: null,
      description: "d",
      d: null,
    },
  ],
  [
    "tags: [a, b]\ndescription: d",
    {
      name: null,
      description: "d",
      d: null,
    },
  ],
  ['description: "unterminated', null],
  [
    "disable-model-invocation: true\ndescription: d",
    {
      name: null,
      description: "d",
      d: true,
    },
  ],
  [
    "description:\nname: n",
    {
      name: "n",
      description: null,
      d: null,
    },
  ],
  [
    "description: 123",
    {
      name: null,
      description: 123,
      d: null,
    },
  ],
  [
    "description: ~",
    {
      name: null,
      description: null,
      d: null,
    },
  ],
  [
    "# comment\ndescription: d\n",
    {
      name: null,
      description: "d",
      d: null,
    },
  ],
  [
    'description: "a: b"',
    {
      name: null,
      description: "a: b",
      d: null,
    },
  ],
  [
    "description: tab\there",
    {
      name: null,
      description: "tab\there",
      d: null,
    },
  ],
  [
    "description: a\n\n  b",
    {
      name: null,
      description: "a\nb",
      d: null,
    },
  ],
  [
    "description: |\n    deep\n      deeper\n",
    {
      name: null,
      description: "deep\n  deeper\n",
      d: null,
    },
  ],
  ["license: Apache-2.0\ndescription: Creates docx files. Use when: user asks", null],
  [
    "description: >\n  Long text\n  that wraps.\nlicense: MIT",
    {
      name: null,
      description: "Long text that wraps.\n",
      d: null,
    },
  ],
  ["description: ok\n---", null],
  ["description: @at", null],
];

describe("技能 frontmatter（YAML 子集）", () => {
  it.each(CASES)("与 Core 的解析结果一致：%j", (yaml, expected) => {
    if (expected === null) {
      expect(() => parseYamlSubset(yaml)).toThrow();
      return;
    }
    const data = parseYamlSubset(yaml);
    expect(data.name ?? null).toEqual(expected.name ?? null);
    expect(data.description ?? null).toEqual(expected.description ?? null);
    expect(data["disable-model-invocation"] ?? null).toEqual(expected.d ?? null);
  });

  it("不认识的写法拒绝（宁可不装）：整体缩进、多行单引号", () => {
    expect(() => parseYamlSubset("  description: x")).toThrow();
    expect(() => parseYamlSubset("description: 'a\n  b'")).toThrow();
  });

  it("frontmatter 的边界与 Core 一致", () => {
    expect(extractFrontmatter("\uFEFF---\r\nname: a\r\n---\r\nbody")).toBe("name: a");
    expect(extractFrontmatter("# 标题\n---\nname: a\n---")).toBeNull();
    expect(extractFrontmatter("---\nname: a")).toBeNull();
  });

  it("缺 description 阻止安装；名称与长度只告警；name 缺省用目录名", () => {
    const ok = checkSkill("---\nname: pdf-tools\ndescription: 处理 PDF\n---\n", "dir");
    expect(ok).toEqual({ name: "pdf-tools", description: "处理 PDF", errors: [], warnings: [] });
    const noDesc = checkSkill("---\nname: a\n---\n", "dir");
    expect(noDesc.errors).toHaveLength(1);
    expect(checkSkill("没有 frontmatter", "x").errors).toHaveLength(1);
    const blank = checkSkill('---\ndescription: "  "\n---', "x");
    expect(blank.errors).toHaveLength(1);
    const warn = checkSkill(`---\nname: My_Skill\ndescription: ${"x".repeat(1025)}\n---`, "d");
    expect(warn.errors).toEqual([]);
    expect(warn.warnings).toHaveLength(2);
    expect(checkSkill("---\ndescription: d\n---", "From-Dir").name).toBe("From-Dir");
    const bad = checkSkill("---\ndescription: a: b\n---", "x");
    expect(bad.errors[0]).toMatch(/无法解析/);
  });

  it("安装目录名", () => {
    expect(suggestDirName(" PDF 工具 v2 ")).toBe("PDF--v2");
    expect(suggestDirName("..hidden")).toBe("hidden");
    for (const ok of ["pdf", "a.b", "my_skill-2"]) expect(validDirName(ok)).toBe(true);
    for (const bad of ["", ".x", "a/b", "con", "x.", "名", "a b", "x".repeat(65)])
      expect(validDirName(bad)).toBe(false);
  });
});
