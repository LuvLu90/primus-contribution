import { describe, expect, it } from "vitest";
import attach from "./attach/index.ts";
import auth from "./auth/index.ts";
import checkpoint from "./checkpoint/index.ts";
import contextStats from "./context-stats/index.ts";
import guard from "./guard/index.ts";
import imagegen from "./imagegen/index.ts";
import primus, { modules } from "./index.ts";
import narrate from "./narrate/index.ts";
import plan from "./plan/index.ts";
import preview from "./preview/index.ts";
import subagent from "./subagent/index.ts";
import web from "./web/index.ts";

describe("primus-bundle 扩展入口", () => {
  it("默认导出工厂函数（Core 的 -e 只接受默认导出的工厂）", () => {
    expect(typeof primus).toBe("function");
  });

  it("注册全部 11 个第一方扩展且不重复", () => {
    expect(modules).toHaveLength(11);
    expect(new Set(modules).size).toBe(11);
    for (const ext of modules) expect(typeof ext).toBe("function");
    expect(modules).toEqual(
      expect.arrayContaining([
        guard,
        auth,
        checkpoint,
        subagent,
        plan,
        narrate,
        contextStats,
        attach,
        preview,
        imagegen,
        web,
      ]),
    );
  });

  it("web 排在 narrate 前：先按设置增减联网工具，narrate 再渲染系统提示词（ADR 0020）", () => {
    expect(modules.indexOf(web)).toBeLessThan(modules.indexOf(narrate));
  });

  it("guard 最先注册，保证其他扩展的工具调用都经过审批（附录 A）", () => {
    expect(modules[0]).toBe(guard);
  });

  it("工厂可被 Core 调用：依次注册各模块不抛错", () => {
    expect(() => primus({})).not.toThrow();
  });
});
