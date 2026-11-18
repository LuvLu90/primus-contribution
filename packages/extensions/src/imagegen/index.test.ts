import { join, resolve } from "node:path";
import { IMAGEGEN_TOOL } from "@primus/protocol";
import { describe, expect, it, vi } from "vitest";
import imagegen, {
  createImageGen,
  IMAGE_SECRET_ID,
  type ImageGenDeps,
  imageExt,
  imagesDirOf,
  MAX_IMAGE_BYTES,
  MODELS,
  modelChain,
  normalizeParams,
  readCapped,
} from "./index.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B64 = Buffer.from(PNG).toString("base64");
const CORE = "/opt/Primus/data/users/S-1/core";
// 按运行平台解析（CI 也在 Windows 上跑）
const IMAGES = resolve(CORE, "..", "images");
const SAVED = join(IMAGES, "sess_1", "call_1-1000-1.png");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const ok = (n = 1) =>
  json(200, {
    data: Array.from({ length: n }, () => ({
      b64_json: PNG_B64,
      width: 1024,
      height: 1024,
      revised_prompt: "a cat",
    })),
  });

function makeDeps(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const written = new Map<string, Uint8Array>();
  const run = vi.fn((_exe: string, _args: string[]) => "sk-test-image\n");
  const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) =>
    fetchImpl(String(url), init),
  );
  const deps: ImageGenDeps = {
    env: {
      PRIMUS_CODING_AGENT_DIR: CORE,
      PRIMUS_EXE: "/opt/Primus/Primus.exe",
      PRIMUS_IMAGE_BASE_URL: "https://img.example.test/v1/",
    },
    fetch: fetchMock as unknown as typeof fetch,
    run,
    readFile: async () => PNG,
    fileSize: async (p) => (p.includes("missing") ? undefined : p.includes("huge") ? 30e6 : 100),
    writeFile: async (p, d) => {
      written.set(p, d);
    },
    mkdir: async () => {},
    now: () => 1000,
    platform: "linux",
  };
  return { deps, written, run, fetchMock };
}

const ctx = { cwd: "/work/proj", sessionManager: { getSessionId: () => "sess/1" } };

describe("primus-imagegen 参数与工具函数", () => {
  it("意图映射到模型，失败时按顺序兜底且不重复", () => {
    expect(MODELS).toEqual({
      default: "gpt-image-2.6",
      fast: "gpt-image-2.6-flare",
      quality: "gpt-image-2.6-sunburst",
    });
    expect(modelChain("quality")).toEqual([
      "gpt-image-2.6-sunburst",
      "gpt-image-2.6",
      "gpt-image-2.6-flare",
    ]);
    expect(modelChain("default")).toHaveLength(3);
  });

  it("规范化参数：未知值回到默认，张数夹到 1–4", () => {
    expect(
      normalizeParams({ prompt: " 猫 ", intent: "x" as never, size: "9x9" as never, n: 9 }),
    ).toEqual({ prompt: "猫", intent: "default", size: "1024x1024", n: 4, images: [] });
    expect(
      normalizeParams({ prompt: "猫", n: 0, images: ["a.png", "", 3 as never] }),
    ).toMatchObject({ n: 1, images: ["a.png"] });
  });

  it("图片目录与文件格式", () => {
    expect(imagesDirOf({ PRIMUS_CODING_AGENT_DIR: CORE })).toBe(IMAGES);
    expect(imagesDirOf({})).toBeUndefined();
    expect(imageExt(PNG)).toBe(".png");
    expect(imageExt(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(".jpg");
  });
});

describe("primus-imagegen 生成", () => {
  it("文生图：调用 generations，写入会话目录，结果只给路径不给图片数据", async () => {
    const { deps, written, run, fetchMock } = makeDeps(async () => ok());
    const gen = createImageGen(deps);
    const r = await gen.execute("call 1", { prompt: "一只猫", size: "1536x1024" }, undefined, ctx);
    expect(run).toHaveBeenCalledWith("/opt/Primus/Primus.exe", ["--secret", IMAGE_SECRET_ID]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://img.example.test/v1/images/generations");
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer sk-test-image",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-image-2.6",
      prompt: "一只猫",
      n: 1,
      size: "1536x1024",
    });
    expect(r.isError).toBeUndefined();
    expect(r.details).toMatchObject({
      status: "done",
      model: "gpt-image-2.6",
      revisedPrompt: "a cat",
      images: [{ path: SAVED, width: 1024, height: 1024 }],
    });
    expect([...written.keys()]).toEqual([SAVED]);
    expect(r.content[0]?.text).toContain("[done]");
    expect(r.content[0]?.text).not.toContain(PNG_B64);
  });

  it("密钥只取一次", async () => {
    const { deps, run } = makeDeps(async () => ok());
    const gen = createImageGen(deps);
    await gen.execute("a", { prompt: "猫" }, undefined, ctx);
    await gen.execute("b", { prompt: "狗" }, undefined, ctx);
    expect(run).toHaveBeenCalledOnce();
  });

  it("限流 / 服务端错误时换下一款模型", async () => {
    const statuses = [429, 503];
    const { deps, fetchMock } = makeDeps(async () => {
      const s = statuses.shift();
      return s ? json(s, { error: { message: "busy" } }) : ok(2);
    });
    const r = await createImageGen(deps).execute(
      "c",
      { prompt: "猫", intent: "fast", n: 2 },
      undefined,
      ctx,
    );
    const models = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body)).model);
    expect(models).toEqual(["gpt-image-2.6-flare", "gpt-image-2.6", "gpt-image-2.6-sunburst"]);
    expect(r.details.status).toBe("done");
    expect(r.details.images).toHaveLength(2);
  });

  it("请求被拒（400）时不换模型，照实返回原因", async () => {
    const { deps, fetchMock } = makeDeps(async () =>
      json(400, { error: { message: "content policy" } }),
    );
    const r = await createImageGen(deps).execute("d", { prompt: "x" }, undefined, ctx);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(r.isError).toBe(true);
    expect(r.details.status).toBe("failed");
    expect(r.details.error).toContain("content policy");
  });

  it("全部模型都不可用时失败", async () => {
    const { deps, fetchMock } = makeDeps(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await createImageGen(deps).execute("e", { prompt: "x" }, undefined, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r.details).toMatchObject({ status: "failed", error: "无法连接图片服务" });
  });

  it("用户停止：不再换模型，状态为 cancelled", async () => {
    const ac = new AbortController();
    const { deps, fetchMock } = makeDeps(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          setTimeout(() => ac.abort(), 0);
        }),
    );
    const r = await createImageGen(deps).execute("f", { prompt: "x" }, ac.signal, ctx);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(r.details.status).toBe("cancelled");
  });

  it("带参考图时走 edits（multipart），校验格式、大小与是否存在", async () => {
    const { deps, fetchMock } = makeDeps(async () => ok());
    const gen = createImageGen(deps);
    const r = await gen.execute("g", { prompt: "改成绿色", images: ["a.png"] }, undefined, ctx);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://img.example.test/v1/images/edits");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2.6");
    expect(form.getAll("image[]")).toHaveLength(1);
    expect(r.details).toMatchObject({ status: "done", edit: true });

    for (const [images, msg] of [
      [["a.gif"], "只支持"],
      [["missing.png"], "不存在"],
      [["huge.png"], "超过"],
      [["1.png", "2.png", "3.png", "4.png", "5.png"], "最多"],
    ] as const) {
      const bad = await gen.execute("h", { prompt: "x", images: [...images] }, undefined, ctx);
      expect(bad.details.error).toContain(msg);
    }
  });

  it("缺少提示词时不请求", async () => {
    const { deps, fetchMock } = makeDeps(async () => ok());
    const r = await createImageGen(deps).execute("i", { prompt: "  " }, undefined, ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
  });

  it("取不到密钥时报告不可用", async () => {
    const { deps, fetchMock } = makeDeps(async () => ok());
    deps.run = () => {
      throw new Error("exit 3");
    };
    const r = await createImageGen(deps).execute("j", { prompt: "x" }, undefined, ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.details.error).toBe("图片服务暂不可用");
  });
});

describe("primus-imagegen 审查修正", () => {
  it("readCapped 超过上限时停止读取", async () => {
    const big = new Response(new Uint8Array(64));
    await expect(readCapped(big, 32)).rejects.toThrow("过大");
    expect(await readCapped(new Response(new Uint8Array(8)), 32)).toHaveLength(8);
  });

  it("图片地址下载失败时换下一款模型", async () => {
    let call = 0;
    const { deps, fetchMock } = makeDeps(async (url) => {
      if (url.startsWith("https://cdn.")) throw new TypeError("fetch failed");
      call += 1;
      return call === 1 ? json(200, { data: [{ url: "https://cdn.example.test/a.png" }] }) : ok();
    });
    const r = await createImageGen(deps).execute("d", { prompt: "x" }, undefined, ctx);
    expect(r.details).toMatchObject({ status: "done", model: MODELS.fast });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("保存期间停止：不再写后面的图片，状态为 cancelled", async () => {
    const ac = new AbortController();
    const { deps, written } = makeDeps(async () => ok(2));
    deps.writeFile = async (p, d) => {
      written.set(p, d);
      ac.abort();
    };
    const r = await createImageGen(deps).execute("s", { prompt: "x", n: 2 }, ac.signal, ctx);
    expect(written.size).toBe(1);
    expect(r.details.status).toBe("cancelled");
  });

  it("参考图实际读到的字节超过上限时不发请求", async () => {
    const { deps, fetchMock } = makeDeps(async () => ok());
    deps.readFile = async () => new Uint8Array(MAX_IMAGE_BYTES + 1);
    const r = await createImageGen(deps).execute(
      "r",
      { prompt: "x", images: ["a.png"] },
      undefined,
      ctx,
    );
    expect(r.details.error).toContain("超过");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("primus-imagegen 注册", () => {
  it("薄壳提供了地址与可执行文件时注册 generate_image，声明联网", () => {
    const { deps } = makeDeps(async () => ok());
    const registerTool = vi.fn();
    imagegen({ registerTool }, deps);
    expect(registerTool).toHaveBeenCalledOnce();
    const tool = registerTool.mock.calls[0]?.[0];
    expect(tool.name).toBe(IMAGEGEN_TOOL);
    expect(tool.annotations).toEqual({ readOnlyHint: false, openWorldHint: true });
    expect(tool.parameters.required).toEqual(["prompt"]);
  });

  it("缺少薄壳环境（浏览器预览、测试）时不注册", () => {
    const { deps } = makeDeps(async () => ok());
    deps.env = { PRIMUS_CODING_AGENT_DIR: CORE };
    const registerTool = vi.fn();
    imagegen({ registerTool }, deps);
    imagegen({});
    expect(registerTool).not.toHaveBeenCalled();
  });
});
