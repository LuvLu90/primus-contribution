// primus-imagegen：对话内图片生成（ADR 0018）。注册工具 `generate_image`，由模型按对话自行判断是否出图
// （与 Codex 一样：用户不需要切换模式或点按钮）。
//
// - 接口：内置图片服务（OpenAI Images 兼容）。地址由薄壳经环境变量 PRIMUS_IMAGE_BASE_URL 传入，
//   密钥与 primus-auth 一样直接拉起 `Primus.exe --secret builtin:image` 取得（不经 shell，只留在 Core 进程内存里）。
//   两者缺一（浏览器预览、测试、非乾元环境）时不注册工具。
// - 模型：按意图选择（default → gpt-image-2.6，fast → -flare，quality → -sunburst）；一款失败（网络、超时、
//   限流、服务端错误）时按顺序换下一款，用户无感；请求本身被拒（400 等，如内容不合规）时不再换模型。
// - 结果：图片写到数据目录 `users/<SID>/images/<会话>/`（约束 C2），给模型的结果只有状态、尺寸与路径，
//   不回传图片数据；前端按 details 显示图片卡片（点开大图、保存、复制）。
// - 带参考图（images 参数）时走 /images/edits；参考图按读取处理，primus-guard 决定是否需要确认。

import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  IMAGEGEN_INTENTS,
  IMAGEGEN_MAX_COUNT,
  IMAGEGEN_MAX_REFERENCES,
  IMAGEGEN_SIZES,
  IMAGEGEN_TOOL,
  type ImageGenDetails,
  type ImageGenImage,
  type ImageGenIntent,
  type ImageGenSize,
} from "@primus/protocol";
import { resolveToolPath } from "../guard/index.ts";

/** 意图 → 首选模型 */
export const MODELS: Record<ImageGenIntent, string> = {
  default: "gpt-image-2.6",
  fast: "gpt-image-2.6-flare",
  quality: "gpt-image-2.6-sunburst",
};

/** 取内置图片服务密钥的保险库 ID（薄壳 vault.rs 的 BUILTIN_IMAGE_SECRET） */
export const IMAGE_SECRET_ID = "builtin:image";

/** 单次请求超时（出图通常 20–60 秒） */
export const REQUEST_TIMEOUT_MS = 180_000;
/** 单张参考图与单张结果的大小上限（与薄壳 attachments.rs 的 MAX_INPUT_BYTES 一致） */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 提示词最大长度（字符） */
const MAX_PROMPT = 8000;

const REFERENCE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** 给模型看的文案（集中管理） */
const TEXT = {
  description:
    "生成或修改图片，生成的图片会直接显示在用户的对话里（用户可以点开大图、保存）。用户想要画图、配图、设计图标 / 海报 / 插画 / 头像、把文字描述变成图片，或修改一张已有图片时使用。",
  snippet: "生成或修改图片，结果直接显示在对话中",
  guidelines: [
    "用户明确或隐含地想要一张图片（画、生成、设计、做个图、来张图、改这张图……）时调用 generate_image；只是讨论、解释图片或写代码画图（SVG、canvas、matplotlib）时不要调用。",
    "prompt 写成完整、具体的画面描述：主体、场景、构图、风格、光线、色彩；画面里要出现的文字用引号写明原文。用户只给一句简短描述时由你补全细节，但不要改变用户的原意。",
    "intent：默认 default；用户要草图、多个方案、快速试试时用 fast；要海报、写实照片、细节或文字要求高时用 quality。",
    "size：方图 1024x1024（默认）；横幅、桌面壁纸、封面用 1536x1024；手机壁纸、竖版海报用 1024x1536。",
    "用户要求修改之前生成的或用户提供的图片时，把图片路径放进 images（最多 4 张）。",
    "一轮里通常只调用一次；用户要多张时用 n（最多 4），不要连续调用。",
    "图片已经显示给用户：结果出来后用一两句话说明画了什么、可以怎么调整即可，不要用 Markdown 嵌入图片，也不要再调用 preview 打开它。",
  ],
  params: {
    prompt: "完整的画面描述（中文或英文）",
    intent: "default 通用；fast 快速草图；quality 高质量（写实、海报、文字）",
    size: "图片尺寸",
    n: "生成张数，1–4，默认 1",
    images: "要修改或参考的本机图片路径（相对当前工作目录或绝对路径，PNG / JPEG / WebP）",
  },
  done: (count: number, model: string, size: string) =>
    `[done] 已生成 ${count} 张图片（模型 ${model}，${size}），已显示在用户的对话中`,
  failed: "[failed] 图片生成失败",
  cancelled: "[cancelled] 用户已停止生成",
  error: {
    prompt: "缺少画面描述（prompt）",
    promptTooLong: `画面描述超过 ${MAX_PROMPT} 个字符`,
    tooManyRefs: `参考图最多 ${IMAGEGEN_MAX_REFERENCES} 张`,
    refType: (p: string) => `参考图只支持 PNG / JPEG / WebP：${p}`,
    refMissing: (p: string) => `参考图不存在或无法读取：${p}`,
    refTooLarge: (p: string) => `参考图超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB：${p}`,
    unavailable: "图片服务暂不可用",
    rejected: (msg: string) => `图片服务拒绝了这次请求：${msg}`,
    empty: "图片服务没有返回图片",
    timeout: "图片服务响应超时",
    network: "无法连接图片服务",
    tooLarge: "返回的图片过大",
  },
} as const;

/** 失败分类：retry 换下一款模型；stop 不再尝试（请求本身被拒或已取消） */
export class ImageGenError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
  }
}

export interface ImageGenParams {
  prompt: string;
  intent?: ImageGenIntent;
  size?: ImageGenSize;
  n?: number;
  images?: string[];
}

/** 工具参数（JSON Schema；Core 对非 TypeBox 的 schema 按 JSON Schema 校验） */
export const IMAGEGEN_PARAMETERS = {
  type: "object",
  properties: {
    prompt: { type: "string", description: TEXT.params.prompt },
    intent: { type: "string", enum: [...IMAGEGEN_INTENTS], description: TEXT.params.intent },
    size: { type: "string", enum: [...IMAGEGEN_SIZES], description: TEXT.params.size },
    n: {
      type: "integer",
      minimum: 1,
      maximum: IMAGEGEN_MAX_COUNT,
      description: TEXT.params.n,
    },
    images: {
      type: "array",
      items: { type: "string" },
      maxItems: IMAGEGEN_MAX_REFERENCES,
      description: TEXT.params.images,
    },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;

export interface ImageGenDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** 直接拉起程序（不经 shell），返回 stdout */
  run: (exe: string, args: string[]) => string;
  readFile: (path: string) => Promise<Uint8Array>;
  fileSize: (path: string) => Promise<number | undefined>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  now: () => number;
  platform: NodeJS.Platform;
}

const defaultDeps = (): ImageGenDeps => ({
  env: process.env,
  fetch: (...args) => fetch(...args),
  run: (exe, args) =>
    execFileSync(exe, args, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  readFile: async (p) => new Uint8Array(await readFile(p)),
  fileSize: async (p) => {
    try {
      const s = await stat(p);
      return s.isFile() ? Number(s.size) : undefined;
    } catch {
      return undefined;
    }
  },
  writeFile: (p, d) => writeFile(p, d),
  mkdir: async (p) => {
    await mkdir(p, { recursive: true });
  },
  now: () => Date.now(),
  platform: process.platform,
});

/** 图片保存目录 `users/<SID>/images`：PRIMUS_CODING_AGENT_DIR（`users/<SID>/core`）的同级目录；未设置为 undefined */
export function imagesDirOf(env: Record<string, string | undefined>): string | undefined {
  const core = env.PRIMUS_CODING_AGENT_DIR;
  return core ? resolve(core, "..", "images") : undefined;
}

/** 首选模型在前，其余按 default → fast → quality 兜底，不重复 */
export function modelChain(intent: ImageGenIntent): string[] {
  return [...new Set([MODELS[intent], MODELS.default, MODELS.fast, MODELS.quality])];
}

/** 规范化参数：未知意图 / 尺寸回到默认，张数夹到 1–4 */
export function normalizeParams(p: Partial<ImageGenParams> | undefined): {
  prompt: string;
  intent: ImageGenIntent;
  size: ImageGenSize;
  n: number;
  images: string[];
} {
  const prompt = typeof p?.prompt === "string" ? p.prompt.trim() : "";
  const intent = IMAGEGEN_INTENTS.includes(p?.intent as ImageGenIntent)
    ? (p?.intent as ImageGenIntent)
    : "default";
  const size = IMAGEGEN_SIZES.includes(p?.size as ImageGenSize)
    ? (p?.size as ImageGenSize)
    : "1024x1024";
  const raw = Number(p?.n);
  const n = Number.isFinite(raw) ? Math.min(IMAGEGEN_MAX_COUNT, Math.max(1, Math.trunc(raw))) : 1;
  const images = Array.isArray(p?.images)
    ? p.images.filter((s): s is string => typeof s === "string" && s.trim() !== "")
    : [];
  return { prompt, intent, size, n, images };
}

/** 文件名里只保留安全字符（会话 ID、工具调用 ID 来自 Core，仍然过滤一遍） */
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "image";

/** 按文件头判断图片格式，决定扩展名 */
export function imageExt(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45
  )
    return ".webp";
  return ".png";
}

/** 错误响应里的说明（OpenAI 格式 `{error:{message}}`，或纯文本），截断到 300 字符 */
function errorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const m =
      typeof j.error === "string"
        ? j.error
        : typeof j.error?.message === "string"
          ? j.error.message
          : typeof j.message === "string"
            ? j.message
            : "";
    if (m) return m.slice(0, 300);
  } catch {}
  return body.trim().slice(0, 300);
}

interface ApiImage {
  b64_json?: string;
  url?: string;
  width?: number;
  height?: number;
  revised_prompt?: string;
}

/** 超时与用户停止合并成一个信号；返回清理函数 */
function linkedSignal(
  user: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const ctl = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    ctl.abort();
  }, ms);
  timer.unref?.();
  const onAbort = () => ctl.abort();
  if (user?.aborted) ctl.abort();
  else user?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ctl.signal,
    timedOut: () => timeout,
    done: () => {
      clearTimeout(timer);
      user?.removeEventListener("abort", onAbort);
    },
  };
}

/** JSON 响应上限：容纳 IMAGEGEN_MAX_COUNT 张最大图片的 base64 与少量元数据。 */
const MAX_RESPONSE_BYTES = Math.ceil((IMAGEGEN_MAX_COUNT * MAX_IMAGE_BYTES * 4) / 3) + 1024 * 1024;

/** 边读边累计字节，超过 limit 立即取消读取（不先把整个响应缓冲进内存）。 */
export async function readCapped(res: Response, limit: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > limit) throw new ImageGenError(TEXT.error.tooLarge, false);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ImageGenError(TEXT.error.tooLarge, false);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** 一次请求：成功返回图片字节与元数据；失败抛 ImageGenError（retry 表示可换模型），用户停止时抛 AbortError */
export async function requestImages(
  deps: ImageGenDeps,
  opts: {
    baseUrl: string;
    apiKey: string;
    model: string;
    prompt: string;
    size: ImageGenSize;
    n: number;
    references: { name: string; mime: string; bytes: Uint8Array }[];
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<{ images: { bytes: Uint8Array; width?: number; height?: number }[]; revised?: string }> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const edit = opts.references.length > 0;
  let body: BodyInit;
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.apiKey}` };
  if (edit) {
    const form = new FormData();
    form.append("model", opts.model);
    form.append("prompt", opts.prompt);
    form.append("n", String(opts.n));
    if (opts.size !== "auto") form.append("size", opts.size);
    for (const r of opts.references)
      form.append("image[]", new Blob([r.bytes as BlobPart], { type: r.mime }), r.name);
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      model: opts.model,
      prompt: opts.prompt,
      n: opts.n,
      ...(opts.size === "auto" ? {} : { size: opts.size }),
    });
  }
  const link = linkedSignal(opts.signal, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await deps.fetch(`${base}/images/${edit ? "edits" : "generations"}`, {
        method: "POST",
        headers,
        body,
        signal: link.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new ImageGenError(link.timedOut() ? TEXT.error.timeout : TEXT.error.network, true);
    }
    const failed = (e: unknown): never => {
      if (opts.signal?.aborted || e instanceof ImageGenError) throw e;
      throw new ImageGenError(link.timedOut() ? TEXT.error.timeout : TEXT.error.network, true);
    };
    const text = new TextDecoder().decode(await readCapped(res, MAX_RESPONSE_BYTES).catch(failed));
    if (!res.ok) {
      // 限流、服务端错误、鉴权 / 模型不可用：换下一款；其余（400、422 等，多为内容审核）：照实告诉模型
      const retry =
        res.status === 429 ||
        res.status >= 500 ||
        res.status === 401 ||
        res.status === 403 ||
        res.status === 404;
      if (retry) throw new ImageGenError(`${TEXT.error.unavailable}（HTTP ${res.status}）`, true);
      throw new ImageGenError(
        TEXT.error.rejected(errorMessage(text) || `HTTP ${res.status}`),
        false,
      );
    }
    let data: ApiImage[] = [];
    try {
      const j = JSON.parse(text) as { data?: ApiImage[] };
      data = Array.isArray(j.data) ? j.data : [];
    } catch {
      throw new ImageGenError(TEXT.error.empty, true);
    }
    const images: { bytes: Uint8Array; width?: number; height?: number }[] = [];
    for (const item of data) {
      let bytes: Uint8Array | undefined;
      if (typeof item.b64_json === "string" && item.b64_json) {
        if ((item.b64_json.length * 3) / 4 > MAX_IMAGE_BYTES)
          throw new ImageGenError(TEXT.error.tooLarge, false);
        bytes = new Uint8Array(Buffer.from(item.b64_json, "base64"));
      } else if (typeof item.url === "string" && /^https:\/\//i.test(item.url)) {
        const r = await deps.fetch(item.url, { signal: link.signal }).catch(failed);
        if (!r.ok) continue;
        bytes = await readCapped(r, MAX_IMAGE_BYTES).catch(failed);
      }
      if (bytes && bytes.byteLength > 0)
        images.push({
          bytes,
          ...(typeof item.width === "number" ? { width: item.width } : {}),
          ...(typeof item.height === "number" ? { height: item.height } : {}),
        });
    }
    if (images.length === 0) throw new ImageGenError(TEXT.error.empty, true);
    const revised = data.find((d) => typeof d.revised_prompt === "string")?.revised_prompt;
    return { images, ...(revised ? { revised } : {}) };
  } finally {
    link.done();
  }
}

/** 扩展 API 中这里用到的部分（类型不从上游包导入，见 AGENTS.md 第 2.2 节） */
interface ToolContext {
  cwd?: string;
  sessionManager?: { getSessionId?: () => string | undefined };
}
interface ToolResult {
  content: { type: "text"; text: string }[];
  details: ImageGenDetails;
  isError?: boolean;
}
interface ImageGenApi {
  registerTool: (tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
    execute: (
      toolCallId: string,
      params: ImageGenParams,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ToolContext,
    ) => Promise<ToolResult>;
  }) => void;
}

/** 创建工具执行器：密钥取到后缓存在内存里 */
export function createImageGen(deps: ImageGenDeps = defaultDeps()) {
  let apiKey: string | undefined;

  const getKey = (): string | undefined => {
    if (apiKey) return apiKey;
    const exe = deps.env.PRIMUS_EXE;
    if (!exe) return undefined;
    try {
      const key = deps.run(exe, ["--secret", IMAGE_SECRET_ID]).trim();
      if (key) apiKey = key;
    } catch {}
    return apiKey;
  };

  /** 是否可用：薄壳传了地址、可执行文件与数据目录 */
  const available = () =>
    Boolean(deps.env.PRIMUS_IMAGE_BASE_URL && deps.env.PRIMUS_EXE && imagesDirOf(deps.env));

  async function execute(
    toolCallId: string,
    params: ImageGenParams,
    signal: AbortSignal | undefined,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const p = normalizeParams(params);
    const details: ImageGenDetails = {
      status: "failed",
      prompt: p.prompt,
      intent: p.intent,
      size: p.size,
      images: [],
      ...(p.images.length ? { edit: true } : {}),
    };
    const fail = (error: string): ToolResult => {
      details.status = "failed";
      details.error = error;
      return {
        content: [{ type: "text", text: `${TEXT.failed}：${error}` }],
        details,
        isError: true,
      };
    };
    if (!p.prompt) return fail(TEXT.error.prompt);
    if (p.prompt.length > MAX_PROMPT) return fail(TEXT.error.promptTooLong);
    if (p.images.length > IMAGEGEN_MAX_REFERENCES) return fail(TEXT.error.tooManyRefs);

    // 参考图：按 Core 的规则解析路径，只接受 PNG / JPEG / WebP，单张不超过 20 MB
    const cwd = ctx.cwd ?? process.cwd();
    const references: { name: string; mime: string; bytes: Uint8Array }[] = [];
    for (const raw of p.images) {
      const path = resolveToolPath(raw, cwd, deps.platform);
      const mime = REFERENCE_MIME[extname(path).toLowerCase()];
      if (!mime) return fail(TEXT.error.refType(raw));
      const size = await deps.fileSize(path);
      if (size === undefined) return fail(TEXT.error.refMissing(raw));
      if (size > MAX_IMAGE_BYTES) return fail(TEXT.error.refTooLarge(raw));
      let bytes: Uint8Array;
      try {
        bytes = await deps.readFile(path);
      } catch {
        return fail(TEXT.error.refMissing(raw));
      }
      // 文件可能在取大小之后变大：按实际读到的字节再查一次
      if (bytes.byteLength > MAX_IMAGE_BYTES) return fail(TEXT.error.refTooLarge(raw));
      references.push({
        name: `image-${references.length + 1}${extname(path).toLowerCase()}`,
        mime,
        bytes,
      });
    }

    const baseUrl = deps.env.PRIMUS_IMAGE_BASE_URL;
    const dir = imagesDirOf(deps.env);
    const key = getKey();
    if (!baseUrl || !dir || !key) return fail(TEXT.error.unavailable);

    let lastError: string = TEXT.error.unavailable;
    for (const model of modelChain(p.intent)) {
      if (signal?.aborted) break;
      details.model = model;
      try {
        const out = await requestImages(deps, {
          baseUrl,
          apiKey: key,
          model,
          prompt: p.prompt,
          size: p.size,
          n: p.n,
          references,
          ...(signal ? { signal } : {}),
        });
        const session = safeName(ctx.sessionManager?.getSessionId?.() ?? "default");
        const folder = join(dir, session);
        // 保存期间用户点了停止：不再写后面的图片，按取消返回
        const stopIfCancelled = () => {
          if (signal?.aborted) throw new Error(TEXT.cancelled);
        };
        stopIfCancelled();
        await deps.mkdir(folder);
        stopIfCancelled();
        const stamp = deps.now();
        const saved: ImageGenImage[] = [];
        for (const [i, img] of out.images.entries()) {
          const path = join(
            folder,
            `${safeName(toolCallId)}-${stamp}-${i + 1}${imageExt(img.bytes)}`,
          );
          await deps.writeFile(path, img.bytes);
          stopIfCancelled();
          saved.push({
            path,
            ...(img.width ? { width: img.width } : {}),
            ...(img.height ? { height: img.height } : {}),
          });
        }
        details.status = "done";
        details.images = saved;
        if (out.revised) details.revisedPrompt = out.revised;
        const sizeText =
          saved[0]?.width && saved[0]?.height ? `${saved[0].width}x${saved[0].height}` : p.size;
        return {
          content: [
            {
              type: "text",
              text: `${TEXT.done(saved.length, model, sizeText)}：\n${saved.map((s) => s.path).join("\n")}`,
            },
          ],
          details,
        };
      } catch (e) {
        if (signal?.aborted) break;
        if (e instanceof ImageGenError) {
          lastError = e.message;
          if (!e.retry) return fail(e.message);
          continue;
        }
        return fail((e as Error)?.message || TEXT.error.unavailable);
      }
    }
    if (signal?.aborted) {
      details.status = "cancelled";
      return { content: [{ type: "text", text: TEXT.cancelled }], details, isError: true };
    }
    return fail(lastError);
  }

  return { available, execute };
}

export default function imagegen(pi: unknown, deps?: ImageGenDeps): void {
  const api = pi as Partial<ImageGenApi> | null | undefined;
  if (typeof api?.registerTool !== "function") return;
  const gen = createImageGen(deps);
  if (!gen.available()) return;
  api.registerTool({
    name: IMAGEGEN_TOOL,
    label: "生成图片",
    description: TEXT.description,
    promptSnippet: TEXT.snippet,
    promptGuidelines: [...TEXT.guidelines],
    parameters: IMAGEGEN_PARAMETERS,
    // 联网、写数据目录：primus-guard 对它单独判断（无参考图直接放行，参考图按读取规则）
    annotations: { readOnlyHint: false, openWorldHint: true },
    execute: (toolCallId, params, signal, _onUpdate, ctx) =>
      gen.execute(toolCallId, params, signal, ctx),
  });
}
