# ADR 0014：6 步安装向导（exe 用 BAFunctions，MSI 单对话框分步）

- 状态：已采纳（2026-11-15）
- 修订：ADR 0012 中“准备安装（隐私政策 + 同意 + 安装位置）一页完成”一条；ADR 0012 的其余决定（一个窗口、进度页不订阅动作文字、两边文案一致）不变

## 背景

ADR 0012 把安装前的内容压成一页（隐私政策、同意、安装位置挤在一起）。新的效果图（白底、Primus 全局配色）要求两种安装方式都走同样的 6 步，
且不能退回 WixUI 那种“每步销毁旧窗口、创建新窗口”的闪烁：

1. 欢迎：大图标、“欢迎安装 乾元 Primus”、版本、说明；下一步(N) / 取消
2. 隐私政策：页眉图标 + 标题 + 副标题，带边框的 Privacy.rtf，“我已阅读并同意隐私政策(A)”未勾选时“下一步”禁用；上一步(B) / 下一步(N) / 取消
3. 选择安装位置：目录框 + 更改(C)...；已安装 / NSIS 迁移时锁定并显示说明；灰字说明 data 保留与 UAC；上一步 / 安装(I)（带盾牌）/ 取消
4. UAC：点“安装”后才提权
5. 正在安装：进度条 + 一行固定文字（不变）
6. 安装完成：对勾、“安装完成”、版本、说明；立即启动(L) / 完成(F)（启动逻辑不变）

前三步右上角显示 1/3、2/3、3/3。

## 决定

### exe（WiX 7 Burn，WixStdBA + BAFunctions）

- WixStdBA 只按引擎状态换页（`OnChangeState`），主题的 `ChangePageAction` 换页它不知道；`InstallFolder` 编辑框只在隐藏所在页时回写变量。
  因此三步都放在 WixStdBA 的 **Install 页**里，做成三组控件，各带 `VisibleCondition="PrimusStep = N"`。
- 新增 BAFunctions 原生 DLL（`apps/desktop/src-tauri/windows/bafunctions`，参照 WiX 官方模板 `src/ext/Bal/Samples/bafunctions`），
  经 `<Payload SourceFile="$(BAFunctionsDll)" bal:BAFunctions="yes" />` 放进 BootstrapperApplication 容器：
  - 处理 `PrimusNextButton` / `PrimusBackButton` 的点击：设置 Burn 变量 `PrimusStep`，然后**在同一窗口里**让 thmutil 重新求值：
    给父窗口发隐藏辅助复选框 `PrimusRefresh` 的 `BN_CLICKED`，thmutil 的自动行为执行 `ThemeShowPageEx(REFRESH)`，按
    VisibleCondition / EnableCondition 显隐当前页全部控件（与用户点复选框时完全相同的代码路径，不重建窗口）。
  - **减闪**：整个切换用父窗口 `WM_SETREDRAW FALSE/TRUE` 包住，最后一次 `RedrawWindow(RDW_ALLCHILDREN | RDW_UPDATENOW)`，整页只重画一次；
    同意复选框由 BAFunctions 自己处理（写 `PrimusAgree`、启用“下一步”），不触发整页刷新。
  - `InstallButton`、`EulaRichedit` 是 WixStdBA 管的控件（忽略 Visible / Enable 条件，`OnThemeControlLoaded` 不交给 BAFunctions），
    按 WiX 7.0.0 的固定控件 ID（0x8000、0x8001）取窗口并子类化：不在第 3 / 第 2 步时，在 `WM_WINDOWPOSCHANGING` 里去掉
    `SWP_SHOWWINDOW`，并投递一次纠正（隐藏、禁用、焦点移到当前步骤的默认按钮）。父窗口的 `WM_COMMAND`（先于 WixStdBA 经过 BAFunctions）
    里拦下非第 3 步的“安装”点击（快捷键、默认按钮等任何来源），未同意隐私政策不能开始安装。
  - 不用 `EulaAcceptCheckbox`（WixStdBA 会按它禁用 `InstallButton`，与分步冲突），改用自定义复选框 `PrimusAgree`，
    “下一步”的启用条件为 `PrimusStep = 1 OR PrimusAgree`。
  - 默认按钮（Enter）随步骤用 `DM_SETDEFID` 切换（下一步 / 安装）。
- Burn 在 Install 页上自动给 `InstallButton` 加 UAC 盾牌（`ThemeControlElevates`，按机器安装且未提权）；提权发生在 Apply 阶段，即点“安装”之后。
- DLL 为 **x86**：Bundle 以 `-arch x86` 构建，WixStdBA 界面进程是 x86（ARM64 上经仿真），两个架构的 exe 共用。
  `scripts/build-bafunctions.mjs` 下载与 WiX 工具同版本的 NuGet 原生包（`WixToolset.DUtil`、`WixToolset.BootstrapperApplicationApi`（含 balutil）、
  `WixToolset.WixStandardBootstrapperApplicationFunctionApi`（wixstdfn）），按锁定的 SHA-512 校验，用 vswhere 找到的 MSVC 编译（`/MT` 静态 CRT、
  `/guard:cf`、`/utf-8`）。`build-setup-exe.mjs` 未传 `--bafunctions` 时自动先编译；发布工作流单独一步编译后传入。
  与 exe、MSI 一样不做 Authenticode 签名（ADR 0007）。

### MSI（PrimusUI.wxi）

- 前三步是同一个对话框 `PrimusInstallDlg`：属性 `PRIMUS_STEP`（1～3），“上一步 / 下一步”用 `Publish Property` 切换，
  控件用 `ShowCondition` / `HideCondition` / `EnableCondition` / `DisableCondition` 显隐，**不用 NewDialog**。
  “下一步”在第 2 步按 `PRIMUS_AGREE` 禁用；两条 Publish 先判断大的步骤（MSI 逐条求值条件，避免一次点击连跳两步）。
- “安装”只在第 3 步显示，`ElevationShield="yes"`；UI 序列不提权，执行阶段才请求管理员权限。
- 对话框 416×304 安装单位（约 555×405 像素，与 exe 窗口一致）。白底：每个对话框最下层一张白色位图，文字控件透明；
  分割线 / 边框用 #e1e1e3 位图。

### 样式与限制

- 两边：白底、正文 #1d1d1f、次要 #6e6e73、分割线 #e1e1e3、Microsoft YaHei UI、底部按钮栏上方细分割线；图片由
  `scripts/render-installer-art.py` 生成（exe 为 100%/125%/150%/200% 四种 PNG，thmutil 按控件尺寸挑选；MSI 为 BMP）。
- **主按钮黑底白字没有做**：MSI 的 PushButton 不能自定义底色（只能整块位图、没有文字），两边都用系统按钮保持一致。
- MSI 的复选框不能透明（白底上会露出系统灰底），同意复选框只画方框，文字是旁边的透明文字（点文字不切换勾选）。
- MSI 的 Text 不能居中：欢迎页、完成页的居中文字按估算宽度摆放，与 exe 可能差几个像素。
- 进度条、复选框、滚动条用系统样式。维护模式（修复 / 卸载）、取消、失败页的行为不变，只换成同一套页眉样式。

## 影响

- `UpgradeCode`、静默参数（`/quiet`、`/passive`、`INSTALLFOLDER=`）、NSIS 迁移、目录锁定、PrimusUpdate 服务、`Privacy.rtf` 均不变；
  静默安装不经过向导（`PrimusStep` / `PrimusAgree` 不可从命令行覆盖）。
- exe 构建多一个前提：Windows 构建机需有带 C++ 工具（x86 目标）的 Visual Studio。GitHub 托管的 windows-2025 与 windows-11-arm 运行器自带。
- BAFunctions 依赖 WixStdBA 7.0.0 的控件 ID 与 thmutil 的刷新行为；升级 WiX 时对照 `WixStandardBootstrapperApplication.cpp` 的
  `WIXSTDBA_CONTROL` 枚举与 `NUGET_PACKAGES` 哈希，并在 Windows 上实际走一遍向导（含 125% / 150% DPI）。
- 主题仍由 thmutil 在运行时解析：`setup-theme.xml` 可对照 WiX 的 thmutil xsd 校验，但显隐与焦点只能在 Windows 真机验证（`docs/安装测试清单.md` 第 1a 节）。
