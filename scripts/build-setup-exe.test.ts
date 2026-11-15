import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error 纯 JS 脚本，无类型声明
import {
  BAFUNCTIONS_ARCH,
  BAFUNCTIONS_DEF,
  BAFUNCTIONS_DIR,
  BAFUNCTIONS_DLL,
  BAFUNCTIONS_SOURCES,
  clArgs,
  linkArgs,
  NUGET_LAYOUT,
  nugetPackages,
  nugetUrl,
  vcvarsTargets,
} from "./build-bafunctions.mjs";
// @ts-expect-error 纯 JS 脚本，无类型声明
import {
  BUNDLE_ARCH,
  BUNDLE_EXTENSION,
  BUNDLE_THEME,
  BUNDLE_WXL,
  BUNDLE_WXS,
  checkMsiInput,
  setupExeFileName,
  UTIL_EXTENSION,
  wixBundleArgs,
} from "./build-setup-exe.mjs";

describe("setupExeFileName", () => {
  it("按版本与架构命名，且与旧 NSIS 版的 -setup.exe 区分", () => {
    expect(setupExeFileName("0.1.2", "x64")).toBe("PrimusSetup_0.1.2_x64_zh-CN.exe");
    expect(setupExeFileName("0.1.2", "arm64")).toBe("PrimusSetup_0.1.2_arm64_zh-CN.exe");
    expect(setupExeFileName("1.2.0-beta.1", "x64")).toBe("PrimusSetup_1.2.0-beta.1_x64_zh-CN.exe");
    expect(setupExeFileName("0.1.2", "x64")).not.toMatch(/-setup\.exe$/);
  });

  it("拒绝无法映射为 MSI 版本的版本号与未知架构", () => {
    expect(() => setupExeFileName("1.0", "x64")).toThrow();
    expect(() => setupExeFileName("1.0.0-preview.1", "x64")).toThrow();
    expect(() => setupExeFileName("0.1.2", "x86")).toThrow();
    expect(() => setupExeFileName("0.1.2", undefined)).toThrow();
  });
});

describe("wixBundleArgs", () => {
  const base = {
    productVersion: "0.1.299.0",
    primusVersion: "0.1.2",
    arch: "arm64",
    msi: "a/arm64.msi",
    bafunctions: "b/bafunctions.dll",
    out: "out/s.exe",
    shellDir: "s",
  };

  it("x86 引擎、BootstrapperApplications 扩展、架构与一个 MSI", () => {
    const args = wixBundleArgs(base);
    expect(args.slice(0, 2)).toEqual(["build", BUNDLE_WXS]);
    expect(args).toContain(BUNDLE_EXTENSION);
    expect(args).toContain(UTIL_EXTENSION);
    expect(args).toContain("PrimusVersion=0.1.2");
    expect(args[args.indexOf("-arch") + 1]).toBe(BUNDLE_ARCH);
    expect(BUNDLE_ARCH).toBe("x86");
    expect(args).toContain("ProductVersion=0.1.299.0");
    expect(args).toContain("Arch=arm64");
    expect(args).toContain("Msi=a/arm64.msi");
    expect(args).toContain("BAFunctionsDll=b/bafunctions.dll");
    expect(args.slice(-2)).toEqual(["-o", "out/s.exe"]);
  });

  it("缺少必需参数或架构不对时抛错", () => {
    expect(() => wixBundleArgs({ ...base, msi: undefined })).toThrow();
    expect(() => wixBundleArgs({ ...base, bafunctions: undefined })).toThrow();
    expect(() => wixBundleArgs({ ...base, primusVersion: undefined })).toThrow();
    expect(() => wixBundleArgs({ ...base, arch: "x86" })).toThrow();
  });
});

describe("checkMsiInput", () => {
  const yes = () => true;
  it("文件名须与版本、架构一致", () => {
    expect(checkMsiInput("d/Primus_0.1.2_x64_zh-CN.msi", "0.1.2", "x64", yes)).toBeNull();
    expect(checkMsiInput("d/Primus_0.1.2_arm64_zh-CN.msi", "0.1.2", "arm64", yes)).toBeNull();
    expect(checkMsiInput("d/Primus_0.1.2_arm64_zh-CN.msi", "0.1.2", "x64", yes)).toMatch(
      /x64_zh-CN/,
    );
    expect(checkMsiInput("d/Primus_0.1.1_x64_zh-CN.msi", "0.1.2", "x64", yes)).toMatch(/0\.1\.2/);
    expect(checkMsiInput(undefined, "0.1.2", "arm64", yes)).toMatch(/--msi/);
    expect(checkMsiInput("d/Primus_0.1.2_x64_zh-CN.msi", "0.1.2", "x64", () => false)).toMatch(
      /未找到/,
    );
  });
});

describe("Bundle.wxs", () => {
  const wxs = readFileSync(BUNDLE_WXS, "utf8");

  it("只内嵌一个 MSI，Permanent 且可见：exe 不登记自己的卸载条目，装好的就是 MSI", () => {
    const packages = wxs.match(/<MsiPackage[^>]*>/g) ?? [];
    expect(packages).toHaveLength(1);
    const p = packages[0];
    expect(p).toContain('SourceFile="$(Msi)"');
    expect(p).toContain('Permanent="yes"');
    expect(p).toContain('Visible="yes"');
    expect(p).toContain('Cache="remove"');
  });

  it("只有 exe 自己的界面：不显示 MSI 的内部界面，安装位置经 INSTALLFOLDER 传给 MSI（ADR 0012）", () => {
    expect(wxs.replace(/<!--[\s\S]*?-->/g, "")).not.toContain("DisplayInternalUICondition");
    expect(wxs).toContain('ThemeFile="$(ShellDir)\\windows\\setup-theme.xml"');
    expect(wxs).toContain('LicenseFile="$(ShellDir)\\windows\\Privacy.rtf"');
    expect(wxs).toContain('<MsiProperty Name="INSTALLFOLDER" Value="[InstallFolder]" />');
    // 与 Primus.wxs 一样沿用已安装的目录 / 旧 NSIS 版的目录，并锁定不可改
    expect(wxs).toContain('Key="Software\\Primus" Value="InstallDir" Bitness="always64"');
    expect(wxs).toMatch(/<SetVariable Id="LockFolder" Variable="PrimusFolderLocked"/);
    // 完成页的“立即启动”在 exe 的非提权界面进程里启动
    expect(wxs).toContain('LaunchTarget="[InstallFolder]\\Primus.exe"');
  });

  it("下错架构时拒绝安装（0xAA64 = 43620 为 ARM64），并拦下 32 位系统", () => {
    expect(0xaa64).toBe(43620);
    expect(wxs).toMatch(/<bal:Condition Condition="VersionNT64"/);
    const x64 = /<\?if \$\(Arch\) = "x64" \?>([\s\S]*?)<\?elseif/.exec(wxs)?.[1] ?? "";
    const arm64 = /<\?elseif \$\(Arch\) = "arm64" \?>([\s\S]*?)<\?else\?>/.exec(wxs)?.[1] ?? "";
    expect(x64).toContain('Condition="NOT (NativeMachine = 43620)"');
    expect(x64).toMatch(/arm64/);
    expect(arm64).toContain('Condition="NativeMachine = 43620"');
    expect(arm64).toMatch(/x64/);
    expect(wxs).toMatch(/<\?else\?>\s*<\?error /);
  });

  it("经 exe 安装时告诉 MSI 不要在提权进程中启动 Primus", () => {
    expect(wxs.match(/<MsiProperty Name="PRIMUS_BUNDLE" Value="1" \/>/g)).toHaveLength(1);
    const ui = readFileSync(BUNDLE_WXS.replace("Bundle.wxs", "PrimusUI.wxi"), "utf8");
    expect(ui).toContain('ShowCondition="NOT Installed AND NOT PRIMUS_MODE AND NOT PRIMUS_BUNDLE"');
    const msi = readFileSync(BUNDLE_WXS.replace("Bundle.wxs", "Primus.wxs"), "utf8");
    expect(msi).toContain("NOT Installed AND NOT PRIMUS_BUNDLE");
  });

  it("UpgradeCode 与 MSI 不同", () => {
    const bundleCode = /<Bundle[^>]*UpgradeCode="([^"]+)"/.exec(wxs)?.[1];
    expect(bundleCode).toBe("FD216D87-9A80-4208-A28D-FA4B80241F96");
    expect(bundleCode).not.toBe("5B4199DD-C352-459A-AEB0-7119A884608F");
  });
});

/** XML 属性值解码（&#13;&#10;、&amp; 等），用于比较 wxl 与 wxi 的文案 */
function decodeXml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

const WINDOWS_DIR = BUNDLE_WXS.replace(/Bundle\.wxs$/, "");
const theme = readFileSync(BUNDLE_THEME, "utf8");
const wxl = readFileSync(BUNDLE_WXL, "utf8");
const ui = readFileSync(join(WINDOWS_DIR, "PrimusUI.wxi"), "utf8");
const bundle = readFileSync(BUNDLE_WXS, "utf8");
const loc = (id: string) => {
  const raw = new RegExp(`<String Id="${id}" Value="([^"]*)"`).exec(wxl)?.[1];
  return raw === undefined ? undefined : decodeXml(raw);
};
/** Install 页（向导前三步）与 MSI 的向导对话框 */
const installPage = /<Page Name="Install">[\s\S]*?<\/Page>/.exec(theme)?.[0] ?? "";
const installDlg = /<Dialog Id="PrimusInstallDlg"[\s\S]*?<\/Dialog>/.exec(ui)?.[0] ?? "";
/** MSI 界面所有 Text 属性（去掉 {\字体} 前缀） */
const msiTexts = [...ui.matchAll(/ Text="([^"]*)"/g)].map((m) =>
  decodeXml(m[1] as string).replace(/^\{\\\w+\}/, ""),
);

describe("bundle-zh-CN.wxl", () => {
  const ids = [...wxl.matchAll(/<String Id="([^"]+)"/g)].map((m) => m[1]);

  it("简体中文，覆盖主题用到的字符串", () => {
    expect(wxl).toContain('Culture="zh-CN" Language="2052"');
    for (const id of [
      "Caption",
      "InstallTitle",
      "VersionText",
      "WelcomeTitle",
      "WelcomeText",
      "PrivacyTitle",
      "PrivacySubtitle",
      "FolderTitle",
      "FolderSubtitle",
      "FolderLabel",
      "FolderNote",
      "NextButton",
      "BackButton",
      "ProgressText",
      "SuccessText",
      "InstallMessage",
      "InstallInstallButton",
      "ProgressHeader",
      "SuccessInstallHeader",
      "FailureHyperlinkLogText",
      "FilesInUseExitButton",
    ])
      expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("6 步流程的文案与效果图一致", () => {
    expect(loc("WelcomeTitle")).toBe("欢迎安装 乾元 Primus");
    expect(loc("WelcomeText")).toBe(
      "安装向导将在这台电脑上安装 乾元 Primus。\r\n单击“下一步”继续，或单击“取消”退出。",
    );
    expect(loc("PrivacyTitle")).toBe("隐私政策");
    expect(loc("PrivacySubtitle")).toBe("安装前请阅读并同意隐私政策");
    expect(loc("InstallAcceptCheckbox")).toBe("我已阅读并同意隐私政策(&A)");
    expect(loc("FolderTitle")).toBe("选择安装位置");
    expect(loc("FolderSubtitle")).toBe("乾元 Primus 将安装到下面的文件夹");
    expect(loc("FolderLabel")).toBe("安装位置");
    expect(loc("FolderNote")).toBe(
      "会话记录等数据保存在安装目录的 data 文件夹中，卸载时默认保留。\r\n单击“安装”后，Windows 会请求管理员权限。",
    );
    expect(loc("NextButton")).toBe("下一步(&N)");
    expect(loc("BackButton")).toBe("上一步(&B)");
    expect(loc("InstallInstallButton")).toBe("安装(&I)");
    expect(loc("InstallCancelButton")).toBe("取消");
    expect(loc("InstallBrowseButton")).toBe("更改(&C)...");
    expect(loc("SuccessHeader")).toBe("安装完成");
    expect(loc("SuccessLaunchButton")).toBe("立即启动(&L)");
    expect(loc("SuccessCloseButton")).toBe("完成(&F)");
    for (const n of [1, 2, 3]) expect(loc(`Step${n}Of3`)).toBe(`${n}/3`);
  });
});

describe("setup-theme.xml 与 MSI 界面（ADR 0012 / 0014）", () => {
  it("主题用到的文案都在 bundle-zh-CN.wxl 里", () => {
    const used = [...theme.matchAll(/#\(loc\.(\w+)\)/g)].map((m) => m[1] as string);
    expect(used.length).toBeGreaterThan(10);
    for (const id of used) expect(loc(id), id).toBeDefined();
  });

  it("WixStdBA 认识的控件名都在：隐私政策、安装位置、安装、进度、启动", () => {
    for (const name of [
      "EulaRichedit",
      "InstallFolder",
      "InstallButton",
      "OverallCalculatedProgressbar",
      "LaunchButton",
      "FailureLogFileLink",
    ])
      expect(theme).toContain(`Name="${name}"`);
    // 不用 EulaAcceptCheckbox：WixStdBA 会按它启用 InstallButton，与分步冲突；同意由 PrimusAgree 控制“下一步”
    expect(theme).not.toContain('Name="EulaAcceptCheckbox"');
    // 进度页不显示随时变化的动作文字（闪烁来源）
    expect(theme).not.toContain("OverallProgressPackageText");
    // 同名进度条只能声明一次（WixStdBA 只登记第一个），被动安装沿用 Progress 页
    expect(theme).not.toContain('Page Name="ProgressPassive"');
    expect(theme.match(/Name="OverallCalculatedProgressbar"/g)).toHaveLength(1);
    expect(theme).not.toContain("ExecuteProgressActionDataText");
  });

  it("向导三步都在 Install 页，按 PrimusStep 显隐；安装按钮只在 Install 页、不带 ChangePageAction", () => {
    expect(installPage).not.toBe("");
    expect(theme.replace(/<!--[\s\S]*?-->/g, "")).not.toContain("ChangePageAction");
    expect(theme.match(/Name="InstallButton"/g)).toHaveLength(1);
    expect(installPage).toContain('Name="InstallButton"');
    // 每个控件要么带 PrimusStep 的 VisibleCondition，要么是三步共用 / 由 BAFunctions 管的控件
    const shared = ["EulaRichedit", "InstallButton", "InstallCancelButton", "PrimusRefresh"];
    const controls =
      installPage.match(/<(ImageControl|Label|Richedit|Checkbox|Editbox|Button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(20);
    for (const c of controls) {
      const name = /Name="(\w+)"/.exec(c)?.[1] ?? "";
      if (shared.includes(name)) continue;
      expect(c, c).toMatch(/VisibleCondition="[^"]*PrimusStep = [123]/);
    }
    for (const step of [1, 2, 3]) {
      expect(installPage).toContain(`VisibleCondition="PrimusStep = ${step}"`);
      expect(installPage).toContain(`#(loc.Step${step}Of3)`);
      expect(installPage).toContain(`ImageId="Steps${step}"`);
    }
    // BAFunctions 认识的控件
    expect(installPage).toMatch(
      /<Button Name="PrimusNextButton"[^>]*VisibleCondition="PrimusStep = 1 OR PrimusStep = 2" EnableCondition="PrimusStep = 1 OR PrimusAgree"/,
    );
    expect(installPage).toMatch(
      /<Button Name="PrimusBackButton"[^>]*VisibleCondition="PrimusStep = 2 OR PrimusStep = 3"/,
    );
    expect(installPage).toMatch(
      /<Checkbox Name="PrimusAgree"[^>]*VisibleCondition="PrimusStep = 2"/,
    );
    expect(installPage).toMatch(
      /<Checkbox Name="PrimusRefresh"[^>]*VisibleCondition="PrimusRefreshVisible"/,
    );
    // 目录锁定：编辑框与“更改”禁用，并显示说明
    expect(installPage).toMatch(
      /<Editbox Name="InstallFolder"[^>]*EnableCondition="NOT PrimusFolderLocked"/,
    );
    expect(installPage).toContain('VisibleCondition="PrimusStep = 3 AND PrimusFolderLocked"');
    // HideWhenDisabled 会让 ThemeControlEnable 顺带 ShowWindow，安装按钮不能带
    expect(/<Button Name="InstallButton"[^>]*>/.exec(installPage)?.[0]).not.toContain(
      "HideWhenDisabled",
    );
  });

  it("主题图片都作为 BA 负载打进 exe，且文件存在", () => {
    const files = [...theme.matchAll(/ImageFile="([^"]+)"/g)].map((m) => m[1] as string);
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      expect(bundle, f).toContain(`$(ShellDir)\\windows\\art\\${f}"`);
      expect(existsSync(join(WINDOWS_DIR, "art", f)), f).toBe(true);
    }
    const ids = new Set([...theme.matchAll(/<Image Id="(\w+)"/g)].map((m) => m[1]));
    for (const m of theme.matchAll(/ImageId="(\w+)"/g)) expect(ids.has(m[1])).toBe(true);
  });

  it("exe 与 MSI 的页面文案逐字一致", () => {
    for (const id of [
      "WelcomeTitle",
      "WelcomeText",
      "PrivacyTitle",
      "PrivacySubtitle",
      "InstallAcceptCheckbox",
      "FolderTitle",
      "FolderSubtitle",
      "FolderLabel",
      "FolderNote",
      "InstallFolderLockedText",
      "InstallBrowseButton",
      "NextButton",
      "BackButton",
      "InstallInstallButton",
      "InstallCancelButton",
      "Step1Of3",
      "Step2Of3",
      "Step3Of3",
      "SuccessHeader",
      "SuccessText",
      "SuccessUninstallText",
      "SuccessLaunchButton",
      "SuccessCloseButton",
      "FailureHeader",
    ]) {
      const text = loc(id) as string;
      expect(text, id).toBeDefined();
      expect(msiTexts, id).toContain(text);
    }
    // 版本：exe 用 Burn 变量，MSI 用预处理变量
    expect(loc("VersionText")).toBe("版本 [PrimusVersion]");
    expect(msiTexts).toContain("版本 $(PrimusVersion)");
  });

  it("/layout 完成页不说“已安装完成”", () => {
    const success = /<Page Name="Success">[\s\S]*?<\/Page>/.exec(theme)?.[0] ?? "";
    // WixBundleAction 取 BOOTSTRAPPER_ACTION 的值：Layout = 2
    expect(success).toContain(
      '<Text Condition="WixBundleAction = 2">#(loc.SuccessLayoutHeader)</Text>',
    );
    expect(success).toContain(
      '<Text Condition="WixBundleAction = 2">#(loc.SuccessLayoutText)</Text>',
    );
    expect(loc("SuccessLayoutText")).not.toContain("安装完成");
  });

  it("MSI 的进度页不订阅 ActionText / ActionData，不用 WixUI 的多窗口向导", () => {
    const progress = /<Dialog Id="PrimusProgressDlg"[\s\S]*?<\/Dialog>/.exec(ui)?.[0] ?? "";
    expect(progress).toContain('Event="SetProgress"');
    expect(progress).not.toContain("ActionText");
    expect(progress).not.toContain("ActionData");
    const code = ui.replace(/<!--[\s\S]*?-->/g, "");
    expect(code).not.toContain("WelcomeDlg");
    expect(code).not.toContain("VerifyReadyDlg");
    expect(code).not.toContain("PrepareDlg");
  });

  it("MSI 前三步是同一个对话框：PRIMUS_STEP 切换，不用 NewDialog", () => {
    expect(installDlg).not.toBe("");
    expect(ui.replace(/<!--[\s\S]*?-->/g, "")).not.toContain('Event="NewDialog"');
    expect(ui).toContain('<Property Id="PRIMUS_STEP" Value="1" />');
    const control = (id: string) =>
      new RegExp(`<Control Id="${id}"[^>]*?(?:/>|>[\\s\\S]*?</Control>)`).exec(installDlg)?.[0] ??
      "";
    // 下一步：第 2 步未同意时禁用；Publish 先判断大的步骤（MSI 逐条求值，改了 PRIMUS_STEP 后不会连跳两步）
    const next = control("Next");
    expect(next).toContain(
      'DisableCondition="PRIMUS_STEP = &quot;2&quot; AND PRIMUS_AGREE &lt;&gt; &quot;1&quot;"',
    );
    const nextOrder = [
      ...next.matchAll(/<Publish Property="PRIMUS_STEP" Value="(\d)" Order="(\d)"/g),
    ].map((m) => [m[1], m[2]]);
    expect(nextOrder).toEqual([
      ["3", "1"],
      ["2", "2"],
    ]);
    const backOrder = [
      ...control("Back").matchAll(/<Publish Property="PRIMUS_STEP" Value="(\d)" Order="(\d)"/g),
    ].map((m) => [m[1], m[2]]);
    expect(backOrder).toEqual([
      ["1", "1"],
      ["2", "2"],
    ]);
    // 安装：只在第 3 步出现、带盾牌，且已同意
    const install = control("Install");
    expect(install).toContain('ElevationShield="yes"');
    expect(install).toContain('ShowCondition="PRIMUS_STEP = &quot;3&quot;"');
    expect(install).toContain(
      'EnableCondition="PRIMUS_STEP = &quot;3&quot; AND PRIMUS_AGREE = &quot;1&quot;"',
    );
    expect(install).toMatch(
      /<Publish Event="EndDialog" Value="Return" Order="4" Condition="PRIMUS_STEP = &quot;3&quot; AND PRIMUS_AGREE = &quot;1&quot;/,
    );
    // 同意复选框写 PRIMUS_AGREE；目录锁定时禁用目录与“更改”
    expect(control("Agree")).toContain('Property="PRIMUS_AGREE" CheckBoxValue="1"');
    // 隐藏控件的快捷键不能越过步骤：同意只在第 2 步可用，“更改”只在第 3 步且目录未锁定时可用
    expect(control("Agree")).toContain(
      'EnableCondition="PRIMUS_STEP = &quot;2&quot;" DisableCondition="PRIMUS_STEP &lt;&gt; &quot;2&quot;"',
    );
    expect(control("ChangeFolder")).toContain(
      'EnableCondition="PRIMUS_STEP = &quot;3&quot; AND NOT PRIMUS_FOLDER_LOCKED" DisableCondition="PRIMUS_STEP &lt;&gt; &quot;3&quot; OR PRIMUS_FOLDER_LOCKED"',
    );
    // 每个对话框白底在最下层；高对比度模式下隐藏白底
    const dialogs = [
      ...ui.matchAll(/<Dialog Id="(Primus\w+)"[^>]*>\s*<Control Id="(\w+)"([^>]*)\/>/g),
    ];
    expect(dialogs.length).toBe((ui.match(/<Dialog Id="Primus\w+"/g) ?? []).length);
    for (const m of dialogs) {
      expect(m[2], m[1]).toBe("Background");
      expect(m[3], m[1]).toContain('Text="PrimusBmpWhite"');
      expect(m[3], m[1]).toContain('HideCondition="HighContrast"');
    }
    // 对话框尺寸与 exe 窗口一致（416×304 安装单位 ≈ 555×405 像素）
    for (const m of ui.matchAll(/<Dialog Id="Primus\w+" Width="(\d+)" Height="(\d+)"/g))
      expect([m[1], m[2]]).toEqual(["416", "304"]);
  });
});

describe("BAFunctions（ADR 0014）", () => {
  const cpp = readFileSync(join(BAFUNCTIONS_DIR, "PrimusBAFunctions.cpp"), "utf8");

  it("与 WixStdBA 进程同为 x86，经 bal:BAFunctions 负载引入 BootstrapperApplication", () => {
    expect(BAFUNCTIONS_ARCH).toBe(BUNDLE_ARCH);
    const ba =
      /<BootstrapperApplication>[\s\S]*?<\/BootstrapperApplication>/.exec(bundle)?.[0] ?? "";
    expect(ba).toContain('<Payload SourceFile="$(BAFunctionsDll)" bal:BAFunctions="yes" />');
    expect(BAFUNCTIONS_DLL).toBe("bafunctions.dll");
    // 向导变量：数值型，不能从命令行覆盖
    expect(bundle).toContain('<Variable Name="PrimusStep" Type="numeric" Value="1" />');
    expect(bundle).toContain('<Variable Name="PrimusAgree" Type="numeric" Value="0" />');
  });

  it("源码齐全，导出 WixStdBA 要求的两个入口", () => {
    for (const f of [...BAFUNCTIONS_SOURCES, BAFUNCTIONS_DEF, "precomp.h"])
      expect(existsSync(join(BAFUNCTIONS_DIR, f)), f).toBe(true);
    const def = readFileSync(join(BAFUNCTIONS_DIR, BAFUNCTIONS_DEF), "utf8");
    expect(def).toMatch(/EXPORTS\s+BAFunctionsCreate\s+BAFunctionsDestroy/);
  });

  it("认识主题里的控件名与变量名", () => {
    for (const name of ["PrimusNextButton", "PrimusBackButton", "PrimusAgree", "PrimusRefresh"]) {
      expect(cpp).toContain(`L"${name}"`);
      expect(installPage).toContain(`Name="${name}"`);
    }
    expect(cpp).toContain('L"PrimusStep"');
    // WixStdBA 7.0.0 的固定控件 ID：InstallButton = 0x8000、EulaRichedit = 0x8001
    expect(cpp).toContain("WIXSTDBA_CONTROL_INSTALL_BUTTON_ID = 0x8000");
    expect(cpp).toContain("WIXSTDBA_CONTROL_EULA_RICHEDIT_ID = 0x8001");
    // 批量显隐用 WM_SETREDRAW 包住，整页只重画一次
    expect(cpp).toMatch(/WM_SETREDRAW, FALSE[\s\S]*WM_SETREDRAW, TRUE[\s\S]*RedrawWindow/);
    // 离开 Install 页后隐藏的“上一步 / 下一步”不能经快捷键切换步骤：入口检查 + 隐藏即禁用
    expect(cpp).toMatch(/\(hWnd == m_hwndNext \|\| hWnd == m_hwndBack\) && !CanNavigate\(hWnd\)/);
    expect(cpp).toMatch(/SWP_HIDEWINDOW[\s\S]*EnableWindow\(hWnd, FALSE\)/);
    for (const h of ["m_hwndNext", "m_hwndBack", "m_hwndAgree"])
      expect(cpp).toContain(`Subclass(${h}, ALL_STEPS)`);
  });

  it("vswhere 按 UTF-8 输出，批处理先切到 UTF-8 代码页（非 ASCII 路径）", () => {
    const script = readFileSync(new URL("./build-bafunctions.mjs", import.meta.url), "utf8");
    expect(script).toContain('"-utf8"');
    expect(script).toMatch(/"@echo off",[\s\S]*?"chcp 65001 >nul",[\s\S]*?call \$\{q\(vcvars\)\}/);
  });

  it("WiX 原生 SDK 包与 WiX 工具同版本，按锁定的 SHA-512 下载", () => {
    const baseline = JSON.parse(
      readFileSync(new URL("./version-baseline.json", import.meta.url), "utf8"),
    );
    const pkgs = nugetPackages(baseline.toolchain.wix);
    expect(pkgs.map((p: { id: string }) => p.id).sort()).toEqual(
      [
        "WixToolset.BootstrapperApplicationApi",
        "WixToolset.DUtil",
        "WixToolset.WixStandardBootstrapperApplicationFunctionApi",
      ].sort(),
    );
    for (const p of pkgs) {
      expect(p.version).toBe(baseline.toolchain.wix);
      expect(p.sha512).toMatch(/^[A-Za-z0-9+/]{86}==$/);
      expect(NUGET_LAYOUT[p.id].lib).toContain("/x86/");
    }
    expect(nugetUrl("WixToolset.DUtil", "7.0.0")).toBe(
      "https://api.nuget.org/v3-flatcontainer/wixtoolset.dutil/7.0.0/wixtoolset.dutil.7.0.0.nupkg",
    );
    expect(() => nugetPackages("0.0.1")).toThrow(/SHA-512/);
  });

  it("MSVC 参数：x86 DLL、静态 CRT、UTF-8 源码、按 .def 导出", () => {
    const cl = clArgs({ includeDirs: ["i"], sources: ["a.cpp"], objDir: "o" });
    for (const a of ["/MT", "/utf-8", "/DUNICODE", "/GS", "/guard:cf", "/Ii", "a.cpp"])
      expect(cl).toContain(a);
    const link = linkArgs({ objects: ["a.obj"], def: "x.def", out: "x.dll", libs: ["dutil.lib"] });
    for (const a of [
      "/DLL",
      "/MACHINE:X86",
      "/DEF:x.def",
      "/OUT:x.dll",
      "dutil.lib",
      "user32.lib",
      "gdiplus.lib",
    ])
      expect(link).toContain(a);
    expect(vcvarsTargets("arm64")).toEqual(["arm64_x86", "x86"]);
    expect(vcvarsTargets("x64")).toEqual(["amd64_x86", "x86"]);
  });
});
