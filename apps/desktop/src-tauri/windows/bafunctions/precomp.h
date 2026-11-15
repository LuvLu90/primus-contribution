#pragma once
// 乾元 Primus 安装程序的 BAFunctions（ADR 0014）。参照 WiX 7 官方模板 src/ext/Bal/Samples/bafunctions。

#include <windows.h>
#include <commctrl.h>
#include <msiquery.h>
#include <objbase.h>
#include <shlwapi.h>
#include <stdlib.h>
#include <strsafe.h>

// WiX 原生 SDK（NuGet：WixToolset.DUtil、WixToolset.BootstrapperApplicationApi、
// WixToolset.WixStandardBootstrapperApplicationFunctionApi，版本与 WiX 工具一致）
#include "dutil.h"
#include "dictutil.h"
#include "fileutil.h"
#include "pathutil.h"
#include "strutil.h"
#include "regutil.h"

#include "BootstrapperApplicationBase.h"
#include "balutil.h"

#include "BAFunctions.h"
#include "IBAFunctions.h"

HRESULT WINAPI CreateBAFunctions(
    __in HMODULE hModule,
    __in const BA_FUNCTIONS_CREATE_ARGS* pArgs,
    __inout BA_FUNCTIONS_CREATE_RESULTS* pResults
    );
