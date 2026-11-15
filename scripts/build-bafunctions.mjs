#!/usr/bin/env node
// 编译 exe 安装程序的 BAFunctions 原生 DLL（apps/desktop/src-tauri/windows/bafunctions，ADR 0014）：
// WixStdBA 加载它，在同一个窗口里切换安装向导的三步（欢迎 → 隐私政策 → 选择安装位置）。
//
// - 架构：x86。Bundle 以 -arch x86 构建（BUNDLE_ARCH），WixStdBA 的界面进程是 x86，x64 与 ARM64 两个 exe 共用同一个 DLL
//   （ARM64 Windows 上经 x86 仿真运行）。
// - SDK：WiX 官方 NuGet 原生包 WixToolset.DUtil、WixToolset.BootstrapperApplicationApi（含 balutil）、
//   WixToolset.WixStandardBootstrapperApplicationFunctionApi（wixstdfn），版本与 WiX 工具相同
//   （scripts/version-baseline.json 的 toolchain.wix），按下面锁定的 SHA-512 校验后解压。
// - 编译器：MSVC（vswhere 找到 Visual Studio，vcvarsall 设置 x86 目标环境后直接调用 cl / link），静态 CRT（/MT），
//   不依赖 VC++ 运行库。没有 Authenticode 签名（与 exe、MSI 相同，ADR 0007 / 0011）。
// - WiX 7 原生包要求接受 OSMF EULA（与 `wix eula accept wix7` 相同的许可）；本脚本只在 CI 与已接受该许可的构建机上运行。
//
// 用法：node scripts/build-bafunctions.mjs [--out-dir <目录>] [--dry-run]
//   --out-dir  输出目录，默认仓库根下 out/bafunctions；生成 <目录>/bafunctions.dll
//   --dry-run  只打印将要执行的命令（任何平台）
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));

export const BAFUNCTIONS_DIR = join(root, "apps/desktop/src-tauri/windows/bafunctions");
export const BAFUNCTIONS_SOURCES = ["bafunctions.cpp", "PrimusBAFunctions.cpp"];
export const BAFUNCTIONS_DEF = "bafunctions.def";
export const BAFUNCTIONS_DLL = "bafunctions.dll";
/** 与 build-setup-exe.mjs 的 BUNDLE_ARCH（Burn 引擎 / WixStdBA 进程架构）一致 */
export const BAFUNCTIONS_ARCH = "x86";

/**
 * WiX 原生 SDK 包：id → { 版本: nupkg 的 SHA-512（base64，与 nuget.org 的 packageHash 相同） }。
 * 升级 WiX（version-baseline.json）时同步补上新版本的哈希。
 */
export const NUGET_PACKAGES = {
  "WixToolset.DUtil": {
    "7.0.0":
      "eBBrfNIbOsc8oI4Cy6f9lc26ndbyjWzNl7MTFx0CQao/BKMoXs1y+VKFCHVFaMoURwlZ2op6tugvRMPu5bte2A==",
  },
  "WixToolset.BootstrapperApplicationApi": {
    "7.0.0":
      "exMTJnplE3VsXvoJfoOf/6QaG3rsfXxc3BDj1eOiymdGVtxlh0q4R7ceZnn7Xo8A/EYZgmQJKygaGkMKwlqFQQ==",
  },
  "WixToolset.WixStandardBootstrapperApplicationFunctionApi": {
    "7.0.0":
      "boM/Sj2v/Q3JCUBct+JeKNmCVxjmKBJhCThk+rsnMcPl8EVX7NVUIYW8Msxs9gPgDmewjVDtlW634VzcLLficQ==",
  },
};

/** 各包解压后的头文件与 x86 静态库位置（相对包根目录） */
export const NUGET_LAYOUT = {
  "WixToolset.DUtil": { include: "build/native/include", lib: "build/native/v14/x86/dutil.lib" },
  "WixToolset.BootstrapperApplicationApi": {
    include: "build/native/include",
    lib: "build/native/v14/x86/balutil.lib",
  },
  "WixToolset.WixStandardBootstrapperApplicationFunctionApi": {
    include: "lib/native/include",
    lib: "lib/native/v14/x86/wixstdfn.lib",
  },
};

/** dutil / balutil 用到的 Windows 库（只链接实际引用到的对象） */
export const SYSTEM_LIBS = [
  "kernel32.lib",
  "user32.lib",
  "gdi32.lib",
  "advapi32.lib",
  "shell32.lib",
  "shlwapi.lib",
  "ole32.lib",
  "oleaut32.lib",
  "uuid.lib",
  "comctl32.lib",
  "comdlg32.lib",
  "gdiplus.lib",
  "msimg32.lib",
  "version.lib",
  "crypt32.lib",
  "wininet.lib",
  "winhttp.lib",
  "urlmon.lib",
  "rpcrt4.lib",
  "wintrust.lib",
  "msi.lib",
  "bcrypt.lib",
];

export function nugetUrl(id, version) {
  const lower = id.toLowerCase();
  return `https://api.nuget.org/v3-flatcontainer/${lower}/${version}/${lower}.${version}.nupkg`;
}

/** 某个 WiX 版本要下载的包（id、版本、地址、哈希）；没有锁定哈希的版本直接报错 */
export function nugetPackages(wixVersion) {
  return Object.entries(NUGET_PACKAGES).map(([id, hashes]) => {
    const sha512 = hashes[wixVersion];
    if (!sha512)
      throw new Error(
        `scripts/build-bafunctions.mjs 没有 ${id} ${wixVersion} 的 SHA-512：升级 WiX 时在 NUGET_PACKAGES 中补上`,
      );
    return { id, version: wixVersion, url: nugetUrl(id, wixVersion), sha512 };
  });
}

/** cl 参数：x86、静态 CRT、Unicode、源码 UTF-8（注释为中文）、CFG 与栈保护 */
export function clArgs({ includeDirs, sources, objDir }) {
  return [
    "/nologo",
    "/c",
    "/std:c++17",
    "/utf-8",
    "/W3",
    "/O1",
    "/GS",
    "/guard:cf",
    "/Gy",
    "/EHsc",
    "/MT",
    "/DWIN32",
    "/D_WINDOWS",
    "/DNDEBUG",
    "/DUNICODE",
    "/D_UNICODE",
    ...includeDirs.map((dir) => `/I${dir}`),
    `/Fo${objDir}/`, // 目录以 / 结尾（不用 \，加引号时反斜杠会转义引号）
    ...sources,
  ];
}

/** link 参数：DLL，按 .def 导出 BAFunctionsCreate / BAFunctionsDestroy */
export function linkArgs({ objects, def, out, libs }) {
  return [
    "/nologo",
    "/DLL",
    `/MACHINE:${BAFUNCTIONS_ARCH.toUpperCase()}`,
    `/DEF:${def}`,
    `/OUT:${out}`,
    "/OPT:REF",
    "/OPT:ICF",
    "/GUARD:CF",
    "/DYNAMICBASE",
    "/NXCOMPAT",
    ...objects,
    ...libs,
    ...SYSTEM_LIBS,
  ];
}

/** vcvarsall 的 host_target：按构建机架构选交叉编译到 x86 的工具链，没有时退回 x86（ARM64 上经仿真） */
export function vcvarsTargets(hostArch = process.arch) {
  if (hostArch === "arm64") return ["arm64_x86", "x86"];
  if (hostArch === "x64") return ["amd64_x86", "x86"];
  return ["x86"];
}

/** cmd 参数加引号（路径可能含空格） */
function q(arg) {
  return /[\s&()^|<>"]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
}

function sha512Base64(file) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

function main() {
  const { values: args } = parseArgs({
    options: {
      "out-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const dryRun = args["dry-run"];
  if (process.platform !== "win32" && !dryRun)
    fail("MSVC 只能在 Windows 上运行；在其他平台可用 --dry-run 查看命令");

  const baseline = JSON.parse(readFileSync(join(root, "scripts/version-baseline.json"), "utf8"));
  const wixVersion = baseline.toolchain.wix;
  const outDir = resolve(args["out-dir"] ?? join(root, "out/bafunctions"));
  const pkgDir = join(outDir, "nuget");
  const objDir = join(outDir, "obj");
  const dll = join(outDir, BAFUNCTIONS_DLL);
  let packages;
  try {
    packages = nugetPackages(wixVersion);
  } catch (e) {
    fail(e.message);
  }

  const run = (command, commandArgs) => {
    console.log(`\n> ${[command, ...commandArgs].join(" ")}`);
    if (dryRun) return "";
    const r = spawnSync(command, commandArgs, {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
    });
    if (r.error) fail(`无法启动 ${command}：${r.error.message}`);
    if (r.status !== 0) {
      process.stdout.write(r.stdout ?? "");
      fail(`命令失败（退出码 ${r.status}）：${command} ${commandArgs.join(" ")}`);
    }
    return r.stdout;
  };

  if (!dryRun) mkdirSync(objDir, { recursive: true });

  // 1. 下载并校验 WiX 原生 SDK 包，解压（Windows 10 起自带的 tar 是 bsdtar，能解 zip）
  const includeDirs = [BAFUNCTIONS_DIR];
  const libs = [];
  for (const pkg of packages) {
    const nupkg = join(pkgDir, `${pkg.id}.${pkg.version}.nupkg`);
    const dir = join(pkgDir, `${pkg.id}.${pkg.version}`);
    includeDirs.push(join(dir, NUGET_LAYOUT[pkg.id].include));
    libs.push(join(dir, NUGET_LAYOUT[pkg.id].lib));
    console.log(`\n> 下载 ${pkg.url}`);
    if (dryRun) continue;
    mkdirSync(dir, { recursive: true });
    if (!existsSync(nupkg) || sha512Base64(nupkg) !== pkg.sha512) {
      const r = spawnSync("curl", ["-fsSL", "--retry", "3", "-o", nupkg, pkg.url], {
        stdio: "inherit",
      });
      if (r.status !== 0) fail(`下载失败：${pkg.url}`);
    }
    const actual = sha512Base64(nupkg);
    if (actual !== pkg.sha512) fail(`${pkg.id} ${pkg.version} 的 SHA-512 不符：${actual}`);
    run("tar", ["-xf", nupkg, "-C", dir]);
  }

  // 2. 找到 Visual Studio（MSVC）
  let vcvars = "<vcvarsall.bat>";
  if (!dryRun) {
    const vswhere = join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Visual Studio\\Installer\\vswhere.exe",
    );
    if (!existsSync(vswhere))
      fail(`未找到 vswhere：${vswhere}（需要安装带 C++ 工具的 Visual Studio）`);
    const vsPath = run(vswhere, [
      "-latest",
      "-products",
      "*",
      "-property",
      "installationPath",
    ]).trim();
    vcvars = join(vsPath, "VC\\Auxiliary\\Build\\vcvarsall.bat");
    if (!vsPath || !existsSync(vcvars))
      fail(`未找到 vcvarsall.bat（Visual Studio：${vsPath || "无"}）`);
  }

  // 3. 在 vcvarsall 设置的环境中编译与链接（写成 .cmd 运行，避免多层引号）
  const sources = BAFUNCTIONS_SOURCES.map((f) => join(BAFUNCTIONS_DIR, f));
  const objects = BAFUNCTIONS_SOURCES.map((f) => join(objDir, f.replace(/\.cpp$/, ".obj")));
  const cl = clArgs({ includeDirs, sources, objDir });
  const link = linkArgs({ objects, def: join(BAFUNCTIONS_DIR, BAFUNCTIONS_DEF), out: dll, libs });

  let built = false;
  for (const target of vcvarsTargets()) {
    const script = [
      "@echo off",
      `call ${q(vcvars)} ${target} >nul || exit /b 1`,
      `cl ${cl.map(q).join(" ")} || exit /b 2`,
      `link ${link.map(q).join(" ")} || exit /b 3`,
    ].join("\r\n");
    console.log(`\n> vcvarsall ${target}\n${script}`);
    if (dryRun) {
      built = true;
      break;
    }
    const cmd = join(outDir, "build-bafunctions.cmd");
    writeFileSync(cmd, `${script}\r\n`);
    const r = spawnSync("cmd.exe", ["/d", "/c", cmd], { cwd: outDir, stdio: "inherit" });
    if (r.status === 0) {
      built = true;
      break;
    }
    // vcvarsall 失败（没有该交叉工具链）时换下一个；编译或链接失败直接报错
    if (r.status !== 1) fail(`编译 BAFunctions 失败（退出码 ${r.status}）`);
    console.log(`vcvarsall ${target} 不可用，尝试下一个`);
  }
  if (!built) fail("没有可用的 x86 MSVC 工具链（vcvarsall）");

  if (!dryRun) {
    if (!existsSync(dll)) fail(`没有生成 ${dll}`);
    const digest = createHash("sha256").update(readFileSync(dll)).digest("hex");
    console.log(`\n✓ BAFunctions：${dll}\n  SHA-256：${digest}`);
  } else {
    console.log(`\n✓ （演练）BAFunctions：${dll}`);
  }
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
