# ADR 0013：内置语音转文字（阿里云百炼模型链）

- 状态：已采纳（2026-11-14）
- 取代：技术方案中“语音输入只用 Windows 系统语音识别”的做法

## 背景

原来的语音输入用 Windows `Windows.Media.SpeechRecognition`：依赖系统语音语言包与“联机语音识别”隐私开关，很多电脑默认不可用，出错时还要引导用户去系统设置里打开开关，体验不好。

## 决定

- 语音转文字是内置功能：用户点麦克风即可使用，不需要任何配置，界面上不出现模型、服务商与额度信息。删除系统语音识别及“打开设置”引导。
- 识别在独立的 Rust 库 `apps/desktop/src-tauri/asr/`（`primus-asr`）中完成，薄壳 `platform/speech.rs` 只做转接。按顺序使用阿里云百炼（华北 2 北京）有免费额度的 10 款模型：

  | 顺序 | 模型 | 接口 | 免费额度 |
  | --- | --- | --- | --- |
  | 1 | qwen3-asr-flash-realtime | 实时 WebSocket（realtime） | 10 小时，90 天 |
  | 2 | fun-asr-realtime | 实时 WebSocket（inference） | 10 小时，90 天 |
  | 3 | qwen-audio-3.1-asr-flash-streaming | 实时 WebSocket（inference） | 100 万 Token，90 天 |
  | 4 | qwen-audio-3.1-asr-flash-message | 实时 WebSocket（inference） | 100 万 Token，90 天 |
  | 5 | qwen3-asr-flash | 整段 HTTP（兼容模式） | 10 小时，90 天 |
  | 6 | fun-asr-flash-2026-06-15 | 整段 HTTP（多模态） | 10 小时，90 天 |
  | 7 | qwen-audio-3.1-asr-flash | 整段 HTTP（多模态） | 100 万 Token，90 天 |
  | 8 | paraformer-realtime-v2 | 实时 WebSocket（inference） | 每月 10 小时 |
  | 9 | fun-asr-flash-8k-realtime | 实时 WebSocket（inference，8 kHz） | 10 小时，90 天 |
  | 10 | paraformer-realtime-8k-v2 | 实时 WebSocket（inference，8 kHz） | 每月 10 小时 |

  90 天的一次性额度先用，每月重置的放后面长期兜底；8 kHz 电话模型最后。
- 切换规则：一款模型失败时，从最后一句定稿的结束位置把录音交给下一款（录音只在内存里），用户只看到文字继续出现。额度用完（`AllocationQuota.FreeTierOnly`、欠费）时，每月重置的模型暂停到下月 1 日 0 点（北京时间），一次性额度暂停 30 天；模型不可用（无权限、未开通、参数错误）暂停 24 小时；网络等临时错误不记账：实时模型（WebSocket）连续 2 次临时错误时跳过其余实时模型，改用整段识别的模型（HTTPS）；整段识别也连续 2 次临时错误才停止尝试。没有时间戳的定稿以到达时已录到的位置为检查点。整段识别按 Base64 编码后的大小（不超过 9 MB）判断能否发送。会话结束即释放录音。暂停记录存于数据目录 `app/asr-state.json`。全部不可用时只提示“语音转文字暂不可用”。
- 百炼没有用 API Key 查询剩余额度的接口，只能按调用结果判断。**控制台必须给这 10 款模型都开启“免费额度用完即停”**，否则额度用完后按量计费而不是报错，链条不会切换。
- 密钥：不进仓库。发布工作流从仓库 Secret `PRIMUS_ASR_KEY` 注入，`asr/build.rs` 混淆后编译进 Primus.exe（不出现明文字符串）；缺失时发布失败。开发构建没有注入时麦克风按钮不显示，调试构建可用运行时环境变量 `PRIMUS_ASR_KEY`。
- 麦克风：前端 getUserMedia 采集（WebView2 权限由薄壳自动授予），16 kHz、16 位单声道 PCM 经 `speech_audio`（原始字节请求体，请求头带 `speech_start` 返回的会话编号）送入，不是当前会话的音频丢弃；8 kHz 模型由库内降采样。

## 影响

- 约束 C1（对话模型只支持两种协议）不涉及语音识别：这里不引入任何第三方 SDK，只用 HTTPS 与 WebSocket 直接调用。
- 新增 Rust 依赖 tokio-tungstenite（WebSocket，rustls，系统证书库校验）；HTTPS 沿用 reqwest。两者都跟随系统代理：WebSocket 用 hyper-util 的系统代理识别（与 reqwest 相同：环境变量、Windows“代理服务器”设置），经 HTTP 代理的 CONNECT 隧道连接；SOCKS 代理不支持，直连。
- 密钥随客户端分发，理论上可被逆向取出；风险由“免费额度用完即停”兜底（不会产生费用）。如需更换密钥，更新 Secret 后重新发版。
- 联调：`PRIMUS_ASR_KEY=… cargo run -p primus-asr --example live -- 录音.wav [模型 ID…]` 逐款识别一段 16 kHz WAV。
