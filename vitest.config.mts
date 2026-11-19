import { configDefaults, defineConfig } from "vitest/config";
import coreBase from "./agent-core/vitest.base.ts";

// 根目录 `pnpm test` 只跑本项目代码的单测；agent-core/ 是上游源码，有自己的测试，不在这里跑。
// 前端（jsdom + RTL）用 apps/desktop 自己的配置；其余为 Node 环境。
export default defineConfig({
  test: {
    projects: [
      "apps/desktop/vitest.config.mts",
      {
        test: {
          name: "node",
          include: ["packages/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "agent-core/**", "e2e/**"],
        },
        // 直接测试 Core 源码的用例（如 scripts/core-mcp-config.test.ts）：Core 的工作区包指到源码，沿用 Core 自己的映射
        resolve: { alias: coreBase.resolve?.alias },
      },
    ],
  },
});
