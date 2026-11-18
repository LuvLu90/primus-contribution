# ADR 0018：对话内图片生成

- 状态：已采纳（2026-11-18）
- 修订：技术方案第 4.2、4.4 节、第 17.4 节、附录 A、附录 B；AGENTS.md 第 2.5 节

## 背景

用户希望像 Codex 一样，直接在对话里让 AI 画图：不切换模式、不点按钮，AI 自己判断这句话是不是要一张图，生成后直接显示在回复里，可以点开大图、保存。

约束：不改 `agent-core/`（第 2.3 节），对话模型只支持两种协议（C1），App 数据只写数据目录（C2），密钥不明文落盘（第 2.5 节）。

## 决定

- **实现为第一方扩展**：`packages/extensions/src/imagegen/`（`primus-imagegen`）注册自定义工具 `generate_image`，由对话模型按工具说明与提示词指引自行决定是否调用。参数：`prompt`（必填，模型补全后的画面描述）、`intent`、`size`（`1024x1024` / `1536x1024` / `1024x1536` / `auto`）、`n`（1–4）、`images`（参考图路径，最多 4 张）。
- **内置图片服务**：OpenAI Images 兼容接口（`/images/generations`；带参考图时 `/images/edits`，multipart、字段 `image[]`），返回 `b64_json`。不引入任何 SDK，用 Core 进程的全局 `fetch`（随 Core 的代理设置）。C1 只约束对话模型端点，不涉及图片服务（同 ADR 0013 语音识别）。
- **模型选择**：模型只选意图，扩展映射到具体模型：

  | 意图 | 模型 | 适用 |
  | --- | --- | --- |
  | `default` | `gpt-image-2.6` | 通用 |
  | `fast` | `gpt-image-2.6-flare` | 草图、多方案、快速迭代 |
  | `quality` | `gpt-image-2.6-sunburst` | 海报、写实照片、细节或文字要求高 |

  首选模型失败（网络、超时 180 秒、429、5xx、401 / 403 / 404）时按 default → fast → quality 换下一款（不重复），用户无感；400 等请求被拒（多为内容审核）时不换模型，把原因交给模型解释。用户点停止时立即取消请求，状态 `cancelled`。
- **地址与密钥**：与内置渠道 ioply 相同的做法，只在 `builtin.rs` 各一处：地址 `IMAGE_BASE_URL` 明文，密钥 `BUILTIN_IMAGE_API_KEY` 按 `primus-builtin` 掩码循环异或后以十六进制存放（源码中不出现明文）。薄壳拉起 Core 时设 `PRIMUS_IMAGE_BASE_URL` 与 `PRIMUS_EXE`；扩展用 `execFile` 直接拉起 `Primus.exe --secret builtin:image`（不经 shell），薄壳确认调用方在本 App 的 Core 作业内才输出密钥。密钥只留在 Core 进程内存里，不进环境变量、命令行参数、`models.json` 与日志。缺少这两个环境变量（浏览器预览、测试）时不注册工具。
- **结果**：图片写到 `data/users/<SID>/images/<会话 ID>/<工具调用 ID>-<时间戳>-<序号>.<png|jpg|webp>`（按文件头判断格式）。给模型的工具结果只有状态、模型、尺寸与路径，不回传图片数据（省上下文）；`details` 为 `packages/protocol` 的 `ImageGenDetails`。
- **界面**：`agent-turn` 中 `generate_image` 在工作过程里照常有一行（“正在生成图片 / 已生成图片”），另在总结前显示图片卡片：生成中是与目标尺寸同比例的占位，完成后显示图片（经 `attachment_image` 在内存中读成 data URL），点开用现有 `ImageLightbox` 看大图；卡片悬停与大图右上角提供“复制”（转 PNG 写剪贴板）与“保存”。保存走新增薄壳命令 `image_save`：只接受 `users/<SID>/images` 内（按真实路径比较）的图片，弹系统“另存为”后复制。图片已被删除时显示“图片已不存在”。新增图标 `image`（Reicon `ImageSparkle`）。
- **权限**：`primus-guard` 对 `generate_image` 单独判断：不带参考图时任何模式都放行（只联网、只写 App 自己的图片目录）；参考图会上传，每张按 `read` 的规则判断（工作区外、受保护路径询问），之前生成的图片可直接作为参考图。计划模式交给常规规则。

## 影响

- 新增 Core 环境变量 `PRIMUS_IMAGE_BASE_URL`、`PRIMUS_EXE`；新增数据目录 `users/<SID>/images`（按需创建，不在启动时创建，不计入存储清理）。
- 密钥随客户端分发，理论上可被逆向取出，风险与内置渠道相同；更换时改 `builtin.rs` 一行后发版。
- 威胁模型与模型渠道密钥（`provider:<id>`，第 9.4 节）一致：`--secret` 只校验调用方在本 App 的 Core 作业内，作业内的任何进程（包括 shell 工具运行的命令）都能取到 `builtin:image`。这是有意接受的：作业内进程本就能取到渠道密钥；`PRIMUS_EXE` 只是 `Primus.exe` 的路径，不加环境变量也能从进程信息得到，不扩大暴露面。不对单个扩展进程做身份校验（扩展与 Core 同一进程，无法区分）。
- 生成的图片会一直留在数据目录里，随会话删除不会自动清理；后续可在“存储”页加入清理。
