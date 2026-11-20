# ADR 0023：任务完成与需要处理时的系统通知与提示音

- 状态：已采纳（2026-11-20）
- 修订：技术方案第 4 章（数据目录）、第 8 章（会话状态）、第 16 章（界面清单）、第 18 章、附录 B

## 背景

Agent 一轮常跑几分钟，用户会切去做别的事。技术方案早就写了“切到后台时‘等待确认’和‘完成’会发送系统通知（可在设置中关闭）”，
设置里的通知开关一直是禁用的占位。用户希望参照 Codex 做出任务完成、需要用户输入时的通知与提示音。

Codex 的做法（2026-11 调研）：

- CLI（TUI）：`[tui] notifications` 可选事件 `agent-turn-complete`（一轮结束）与 `approval-requested`（命令、改文件、MCP 请求批准），
  另有计划与提问的提示；`notification_condition` 默认 `unfocused`（只在终端失焦时）可改 `always`；`notification_method` 为 OSC 9 桌面通知或终端响铃。
  文案如“Approval requested: <命令>”“Agent turn complete”。另有 `notify` 外部程序，只在一轮结束时调用，参数带最后一条回复。
- 桌面 App：完成通知可选“从不 / 只在后台 / 始终”，权限请求与提问各有开关；用系统通知，自带一段提示音（`codex-notification.wav`），点击通知回到对应会话。

## 决定

- **两类事件**（与 Codex 对应）：
  - 任务完成：会话从运行中变为空闲。用户自己停止的（最后一条回复 `stopReason` 为 `aborted`）不提醒；出错（`error`）单独成一类“运行出错”；
    结束时正停在提问或计划审批上的，按“需要处理”提醒，不另报完成。正文是最后一条回复去掉 Markdown 后的前 140 字（出错时为错误信息）。
  - 需要处理：新到的扩展对话框（primus-guard 的操作确认、选择、输入、多行编辑）、新的 `ask_user` 提问、计划进入等待批准。
    正文是对话框标题与内容、第一个问题或计划标题。
  - 通知标题为“发生了什么 · 会话名”（会话名取首条用户消息，24 字截断）。
- **何时提醒**：“在看这个会话”= 窗口在前台且有焦点、主界面可见（不在设置等页面）、这个会话是当前会话。
  多会话时在看别的会话也算后台——界面没有标签栏，后台会话结束了用户看不到。
  - 任务完成 / 出错：设置“从不 / 在后台时（默认）/ 始终”。
  - 需要处理：开关（默认开），只在没在看这个会话时提醒（在看时卡片就在眼前）。
- **提示音**：开关（默认开），每次提醒时播放；三种声音一听就能分开——完成是上行两音（E5 → B5），需要处理是同一个音响两下（A5、A5），出错是下行两音（A5 → E5）。
  用 Web Audio 在前端现场合成，不带音频文件、不引入依赖，浏览器预览与桌面端同一套；几个会话同时结束时 0.8 秒内只响一次。
  WebView 的自动播放策略要求页面先有用户操作：首次点击或按键时创建并唤醒音频上下文（用户要先发消息才会有任务完成）。设置里可以试听。
- **系统通知**：Windows 用 WinRT Toast（`windows` crate 已有的 0.62.2，只多开 `Data_Xml_Dom`、`Foundation`、`UI_Notifications` 三个特性，不引入新依赖），
  应用 ID `com.primus.desktop` 与 MSI 快捷方式的 `System.AppUserModel.ID`、identifier 一致；启动时 `SetCurrentProcessExplicitAppUserModelID`，
  不是从快捷方式启动（更新后重开）时通知也归属本应用。Toast 静音（声音由前端按设置播放，不与系统通知音叠加）；同一会话的通知用同一个 Tag 替换。
  点击通知：薄壳把主窗口显示到前台，并经 `notification_watch` 的 Channel 把 tag（前端标签 ID）交给前端，前端切到该会话、回到主界面。
  需要处理的通知在窗口不在前台时同时闪烁任务栏按钮（`request_user_attention`）。
- **职责划分**：判断“该不该提醒、放什么声音”全在前端（`src/features/notifications/`）；薄壳只保存设置、弹通知、点击时拉起窗口，不理解会话内容（第 5 章）。
- **设置**：`users/<SID>/app/notifications.json`（`{ turnComplete, needsInput, sound }`），不存在或无效时用默认值、缺少的字段各取默认值。
  第 18 章原定 App 设置写 `settings.toml`，它接入前与联网设置（`web.json`）一样单独存一个文件。设置·通用的“通知”改为“通知与提示音”三项。
- 新增薄壳命令 `notification_settings_get` / `notification_settings_set` / `notification_show` / `notification_watch`（附录 B）。

## 后果

- 开发模式（`pnpm dev`）没有开始菜单快捷方式，系统不显示 Toast（不报错）；提示音照常。浏览器预览用网页通知代替（允许后显示）。
- 横幅消失后从通知中心点击通知（或应用退出后点击旧通知），系统可能不调用本进程的 `Activated`：只会按快捷方式启动应用（单实例插件把已运行的主窗口拉到前台），不会切到对应会话。要支持需在快捷方式设置 `ToastActivatorCLSID`、注册 `LocalServer32` 并实现 `INotificationActivationCallback`，安装与激活路径改动较大，暂不做；横幅点击覆盖了主要场景。
- 点击横幅时会话标签若已关闭，按通知时记下的会话文件重新打开；新会话尚未落盘、找不到文件时只回到主界面。
- Windows“专注 / 请勿打扰”会压住 Toast，但前端的提示音仍会响；需要时用户可关提示音。
- macOS / Linux 暂不弹系统通知（第 20 章，P3 适配），提示音照常。
- 不提供 Codex `notify` 那样的外部程序钩子；需要时另行决定。
