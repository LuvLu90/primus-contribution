// 乾元 Primus 安装程序（PrimusSetup.exe）的 BAFunctions：在 WixStdBA 的 "Install" 页里切换向导的三步
// （1 欢迎 → 2 隐私政策 → 3 选择安装位置），ADR 0014。
//
// 为什么三步都放在同一个 "Install" 页：WixStdBA 按引擎状态决定显示哪一页（OnChangeState），主题里的
// ChangePageAction 换页后 WixStdBA 不知道；InstallFolder 编辑框也只在隐藏它所在的页时才回写变量。
// 所以 setup-theme.xml 把三步做成 Install 页里的三组控件，各自带 VisibleCondition="PrimusStep = N"，
// 这里只负责改 PrimusStep 并让 thmutil 重新求值一次（同一个窗口里显隐控件，不重建窗口）。
//
// 切换步骤的做法（不闪烁）：
//   1. 设置 Burn 变量 PrimusStep；
//   2. 父窗口 WM_SETREDRAW FALSE；
//   3. 给父窗口发一个隐藏辅助复选框 PrimusRefresh 的 BN_CLICKED：thmutil 的自动行为会写它的变量并
//      ThemeShowPageEx(..., THEME_SHOW_PAGE_REASON_REFRESH)，按 VisibleCondition / EnableCondition / 文字条件
//      重新求值当前页的全部控件（与用户点复选框时 thmutil 做的事完全相同）；
//   4. 纠正 WixStdBA 自己管的两个控件（InstallButton、EulaRichedit：它们排除了自动显隐，thmutil 每次都会显示），
//      并禁用所有隐藏的控件（thmutil 只隐藏不禁用，其他步骤的快捷键仍会触发它们）；
//   5. WM_SETREDRAW TRUE + 一次 RedrawWindow，整页只重画一次；再设置默认按钮与焦点。
//
// WixStdBA 认识的控件（InstallButton、EulaRichedit）不会经 OnThemeControlLoaded 交给 BAFunctions，
// 按它们固定的控件 ID 取窗口（WiX 7.0.0 WixStandardBootstrapperApplication.cpp：
// WIXSTDBA_FIRST_ASSIGN_CONTROL_ID = 0x8000，WIXSTDBA_CONTROL_INSTALL_BUTTON 为第一个，EULA_RICHEDIT 为第二个；
// 升级 WiX 时对照）。这两个控件被 WixStdBA / thmutil 显示（换页、刷新、浏览目录后）时，子类化的窗口过程在
// WM_WINDOWPOSCHANGING 里去掉 SWP_SHOWWINDOW（当前步骤不该显示时），并投递一次纠正（隐藏、禁用、移焦点）。
// 另外在父窗口的 WM_COMMAND 里拦下不在第 3 步时的“安装”点击（快捷键、默认按钮等任何来源），
// 保证不同意隐私政策就不能开始安装。

#include "precomp.h"
#include "BalBaseBAFunctions.h"
#include "BalBaseBAFunctionsProc.h"

namespace
{
    // WiX 7.0.0 WixStdBA 的固定控件 ID（见文件头注释）
    const WORD WIXSTDBA_CONTROL_INSTALL_BUTTON_ID = 0x8000;
    const WORD WIXSTDBA_CONTROL_EULA_RICHEDIT_ID = 0x8001;

    // 投递给父窗口的纠正消息（WixStdBA 用 WM_APP + 100 起的消息，thmutil 用 WM_APP 以下）
    const UINT WM_PRIMUS_FIXUP = WM_APP + 0x300;

    const LPCWSTR VARIABLE_STEP = L"PrimusStep";
    const LPCWSTR VARIABLE_AGREE = L"PrimusAgree";

    const LPCWSTR CONTROL_NEXT = L"PrimusNextButton";
    const LPCWSTR CONTROL_BACK = L"PrimusBackButton";
    const LPCWSTR CONTROL_AGREE = L"PrimusAgree";
    const LPCWSTR CONTROL_REFRESH = L"PrimusRefresh";

    const LPCWSTR PROP_OLD_WNDPROC = L"PrimusBafOldWndProc";
    const LPCWSTR PROP_STEP_MASK = L"PrimusBafStepMask";

    const DWORD FIRST_STEP = 1;
    const DWORD LAST_STEP = 3;

    inline DWORD StepBit(DWORD dwStep)
    {
        return 1u << dwStep;
    }

    BOOL IsWindowClass(HWND hWnd, LPCWSTR wzPrefix)
    {
        WCHAR wzClass[64] = { };
        if (!hWnd || !::GetClassNameW(hWnd, wzClass, countof(wzClass)))
        {
            return FALSE;
        }

        size_t cchPrefix = 0;
        if (FAILED(::StringCchLengthW(wzPrefix, 64, &cchPrefix)))
        {
            return FALSE;
        }

        return CSTR_EQUAL == ::CompareStringOrdinal(wzClass, static_cast<int>(cchPrefix), wzPrefix, static_cast<int>(cchPrefix), TRUE);
    }
}

class CPrimusBAFunctions : public CBalBaseBAFunctions
{
public: // IBAFunctions
    virtual STDMETHODIMP OnThemeLoaded(
        __in HWND hWnd
        )
    {
        HRESULT hr = CBalBaseBAFunctions::OnThemeLoaded(hWnd);
        BalExitOnFailure(hr, "PRIMUSBAF: base OnThemeLoaded failed.");

        vpThis = this;

        hr = m_pEngine->SetVariableNumeric(VARIABLE_STEP, m_dwStep);
        BalExitOnFailure(hr, "PRIMUSBAF: failed to set %ls.", VARIABLE_STEP);

        m_hwndInstall = ::GetDlgItem(hWnd, WIXSTDBA_CONTROL_INSTALL_BUTTON_ID);
        if (!IsWindowClass(m_hwndInstall, WC_BUTTONW))
        {
            BalLog(BOOTSTRAPPER_LOG_LEVEL_ERROR, "PRIMUSBAF: InstallButton (id 0x%x) not found; WixStdBA control ids changed?", WIXSTDBA_CONTROL_INSTALL_BUTTON_ID);
            m_hwndInstall = NULL;
        }

        m_hwndEula = ::GetDlgItem(hWnd, WIXSTDBA_CONTROL_EULA_RICHEDIT_ID);
        if (!IsWindowClass(m_hwndEula, L"RICHEDIT"))
        {
            BalLog(BOOTSTRAPPER_LOG_LEVEL_ERROR, "PRIMUSBAF: EulaRichedit (id 0x%x) not found; WixStdBA control ids changed?", WIXSTDBA_CONTROL_EULA_RICHEDIT_ID);
            m_hwndEula = NULL;
        }

        Subclass(m_hwndInstall, StepBit(3));
        Subclass(m_hwndEula, StepBit(2));

        if (m_hwndEula)
        {
            // 效果图里隐私政策四周有 10～12px 留白（边框由主题里四条 #e1e1e3 线画出）
            HDC hdc = ::GetDC(hWnd);
            int nDpi = hdc ? ::GetDeviceCaps(hdc, LOGPIXELSX) : 96;
            if (hdc)
            {
                ::ReleaseDC(hWnd, hdc);
            }
            int nMargin = ::MulDiv(8, nDpi, 96);
            ::SendMessageW(m_hwndEula, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, MAKELPARAM(nMargin, nMargin));
        }

        if (!m_hwndNext || !m_hwndBack || !m_hwndAgree || !m_hwndRefresh)
        {
            BalLog(BOOTSTRAPPER_LOG_LEVEL_ERROR, "PRIMUSBAF: theme is missing a wizard control (next=%p back=%p agree=%p refresh=%p).", m_hwndNext, m_hwndBack, m_hwndAgree, m_hwndRefresh);
        }

        BalLog(BOOTSTRAPPER_LOG_LEVEL_STANDARD, "PRIMUSBAF: wizard ready, step %u.", m_dwStep);

    LExit:
        return hr;
    }

    virtual STDMETHODIMP OnThemeControlLoaded(
        __in LPCWSTR wzName,
        __in WORD /*wId*/,
        __in HWND hWnd,
        __inout BOOL* /*pfProcessed*/
        )
    {
        if (wzName && *wzName)
        {
            if (IsName(wzName, CONTROL_NEXT))
            {
                m_hwndNext = hWnd;
            }
            else if (IsName(wzName, CONTROL_BACK))
            {
                m_hwndBack = hWnd;
            }
            else if (IsName(wzName, CONTROL_AGREE))
            {
                m_hwndAgree = hWnd;
            }
            else if (IsName(wzName, CONTROL_REFRESH))
            {
                m_hwndRefresh = hWnd;
            }
        }

        return S_OK;
    }

    virtual STDMETHODIMP WndProc(
        __in HWND /*hWnd*/,
        __in UINT uMsg,
        __in WPARAM wParam,
        __in LPARAM lParam,
        __inout BOOL* pfProcessed,
        __inout LRESULT* plResult
        )
    {
        switch (uMsg)
        {
        case WM_COMMAND:
            // 不在第 3 步时不允许开始安装：WixStdBA 在 BAFunctions 之前处理 InstallButton 的点击，
            // 所以在原始的 WM_COMMAND（先经过这里）就拦下
            if (BN_CLICKED == HIWORD(wParam) && m_hwndInstall &&
                (WIXSTDBA_CONTROL_INSTALL_BUTTON_ID == LOWORD(wParam) || reinterpret_cast<HWND>(lParam) == m_hwndInstall) &&
                !CanInstall())
            {
                BalLog(BOOTSTRAPPER_LOG_LEVEL_STANDARD, "PRIMUSBAF: ignored install click at step %u.", m_dwStep);
                *pfProcessed = TRUE;
                *plResult = 0;
            }
            break;

        case WM_PRIMUS_FIXUP:
            m_fFixupPosted = FALSE;
            Fixup();
            *pfProcessed = TRUE;
            *plResult = 0;
            break;
        }

        return S_OK;
    }

    virtual STDMETHODIMP OnThemeControlWmCommand(
        __in WPARAM wParam,
        __in LPCWSTR /*wzName*/,
        __in WORD /*wId*/,
        __in HWND hWnd,
        __inout BOOL* pfProcessed,
        __inout LRESULT* plResult
        )
    {
        if (BN_CLICKED != HIWORD(wParam) || !hWnd)
        {
            return S_OK;
        }

        if (hWnd == m_hwndNext)
        {
            if (FIRST_STEP == m_dwStep)
            {
                GoToStep(2);
            }
            else if (2 == m_dwStep && IsAgreed())
            {
                GoToStep(3);
            }

            *pfProcessed = TRUE;
            *plResult = 0;
        }
        else if (hWnd == m_hwndBack)
        {
            if (FIRST_STEP < m_dwStep)
            {
                GoToStep(m_dwStep - 1);
            }

            *pfProcessed = TRUE;
            *plResult = 0;
        }
        else if (hWnd == m_hwndAgree)
        {
            // 自己处理同意复选框：写变量、启用“下一步”，不走 thmutil 的自动行为（那会刷新整页文字）
            if (2 != m_dwStep)
            {
                // 不在第 2 步（例如隐藏时被快捷键触发）：恢复原来的勾选状态，不改变是否同意
                ::SendMessageW(m_hwndAgree, BM_SETCHECK, IsAgreed() ? BST_CHECKED : BST_UNCHECKED, 0);
                *pfProcessed = TRUE;
                *plResult = 0;
                return S_OK;
            }

            BOOL fChecked = BST_CHECKED == ::SendMessageW(m_hwndAgree, BM_GETCHECK, 0, 0);
            HRESULT hr = m_pEngine->SetVariableNumeric(VARIABLE_AGREE, fChecked ? 1 : 0);
            if (FAILED(hr))
            {
                BalLogError(hr, "PRIMUSBAF: failed to set %ls.", VARIABLE_AGREE);
            }

            if (m_hwndNext && 2 == m_dwStep)
            {
                ::EnableWindow(m_hwndNext, fChecked);
            }

            *pfProcessed = TRUE;
            *plResult = 0;
        }

        return S_OK;
    }

private:
    static BOOL IsName(LPCWSTR wzName, LPCWSTR wzExpected)
    {
        return CSTR_EQUAL == ::CompareStringOrdinal(wzName, -1, wzExpected, -1, FALSE);
    }

    BOOL IsAgreed()
    {
        LONGLONG llAgree = 0;
        HRESULT hr = BalGetNumericVariable(VARIABLE_AGREE, &llAgree);
        return SUCCEEDED(hr) && 0 != llAgree;
    }

    BOOL CanInstall()
    {
        return LAST_STEP == m_dwStep && IsAgreed();
    }

    BOOL IsAllowed(DWORD dwStepMask)
    {
        return 0 != (dwStepMask & StepBit(m_dwStep));
    }

    // 安装向导（Install 页）当前在屏幕上：“上一步”或“下一步”至少一个可见
    BOOL IsWizardShown()
    {
        return (m_hwndNext && ::IsWindowVisible(m_hwndNext)) || (m_hwndBack && ::IsWindowVisible(m_hwndBack));
    }

    void GoToStep(DWORD dwStep)
    {
        if (dwStep < FIRST_STEP || dwStep > LAST_STEP || dwStep == m_dwStep)
        {
            return;
        }

        HRESULT hr = m_pEngine->SetVariableNumeric(VARIABLE_STEP, dwStep);
        BalExitOnFailure(hr, "PRIMUSBAF: failed to set %ls.", VARIABLE_STEP);

        m_dwStep = dwStep;
        BalLog(BOOTSTRAPPER_LOG_LEVEL_STANDARD, "PRIMUSBAF: step %u.", m_dwStep);

        ::SendMessageW(m_hwndParent, WM_SETREDRAW, FALSE, 0);

        if (m_hwndRefresh)
        {
            // 让 thmutil 按 PrimusStep 重新求值 Install 页全部控件的显隐、启用与文字
            ::SendMessageW(m_hwndParent, WM_COMMAND, MAKEWPARAM(::GetDlgCtrlID(m_hwndRefresh), BN_CLICKED), reinterpret_cast<LPARAM>(m_hwndRefresh));
        }

        ApplyBaOwnedControls();
        DisableHiddenControls();

        ::SendMessageW(m_hwndParent, WM_SETREDRAW, TRUE, 0);
        ::RedrawWindow(m_hwndParent, NULL, NULL, RDW_ERASE | RDW_FRAME | RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW);

        SetDefaultAndFocus();

    LExit:
        return;
    }

    // WixStdBA 管理的两个控件：thmutil 刷新时总会显示它们，这里按步骤纠正
    void ApplyBaOwnedControls()
    {
        if (m_hwndInstall)
        {
            BOOL fShow = IsAllowed(StepBit(3));
            ::ShowWindow(m_hwndInstall, fShow ? SW_SHOWNA : SW_HIDE);
            ::EnableWindow(m_hwndInstall, fShow && CanInstall());
        }

        if (m_hwndEula)
        {
            ::ShowWindow(m_hwndEula, IsAllowed(StepBit(2)) ? SW_SHOWNA : SW_HIDE);
        }
    }

    // 隐藏的控件一律禁用：thmutil 按条件隐藏控件时只 ShowWindow(SW_HIDE)，不禁用，其他步骤的快捷键（Alt+C 等）仍会触发它们。
    // thmutil 下次显示某个控件时会按它的 EnableCondition 重新 EnableWindow，所以这里不影响可见控件。
    // 看子窗口自己的 WS_VISIBLE（父窗口 WM_SETREDRAW FALSE 期间 IsWindowVisible 对所有子窗口都返回 FALSE）。
    void DisableHiddenControls()
    {
        for (HWND hwndChild = ::GetWindow(m_hwndParent, GW_CHILD); hwndChild; hwndChild = ::GetWindow(hwndChild, GW_HWNDNEXT))
        {
            if (!(::GetWindowLongPtrW(hwndChild, GWL_STYLE) & WS_VISIBLE) && ::IsWindowEnabled(hwndChild))
            {
                ::EnableWindow(hwndChild, FALSE);
            }
        }
    }

    void SetDefaultAndFocus()
    {
        HWND hwndDefault = (LAST_STEP == m_dwStep) ? m_hwndInstall : m_hwndNext;
        HWND hwndFocus = hwndDefault;

        if (2 == m_dwStep && !IsAgreed())
        {
            hwndFocus = m_hwndAgree;
        }

        if (hwndDefault)
        {
            ::SendMessageW(m_hwndParent, DM_SETDEFID, ::GetDlgCtrlID(hwndDefault), 0);
        }

        if (hwndFocus && ::IsWindowVisible(hwndFocus) && ::IsWindowEnabled(hwndFocus))
        {
            ::SendMessageW(m_hwndParent, WM_NEXTDLGCTL, reinterpret_cast<WPARAM>(hwndFocus), TRUE);
        }
    }

    // WixStdBA / thmutil 刚显示过 Install 页或刷新过它：隐藏不属于当前步骤的控件，焦点不能留在隐藏的控件上
    void Fixup()
    {
        if (!IsWizardShown())
        {
            return;
        }

        ApplyBaOwnedControls();
        DisableHiddenControls();

        HWND hwndFocus = ::GetFocus();
        if (!hwndFocus || !::IsWindowVisible(hwndFocus) || !::IsWindowEnabled(hwndFocus))
        {
            SetDefaultAndFocus();
        }
        else
        {
            HWND hwndDefault = (LAST_STEP == m_dwStep) ? m_hwndInstall : m_hwndNext;
            if (hwndDefault)
            {
                ::SendMessageW(m_hwndParent, DM_SETDEFID, ::GetDlgCtrlID(hwndDefault), 0);
            }
        }
    }

    void PostFixup()
    {
        if (!m_fFixupPosted && m_hwndParent)
        {
            m_fFixupPosted = ::PostMessageW(m_hwndParent, WM_PRIMUS_FIXUP, 0, 0);
        }
    }

    void Subclass(HWND hWnd, DWORD dwStepMask)
    {
        if (!hWnd)
        {
            return;
        }

        ::SetPropW(hWnd, PROP_STEP_MASK, reinterpret_cast<HANDLE>(static_cast<ULONG_PTR>(dwStepMask)));
        LONG_PTR pfnOld = ::SetWindowLongPtrW(hWnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(StepControlWndProc));
        ::SetPropW(hWnd, PROP_OLD_WNDPROC, reinterpret_cast<HANDLE>(pfnOld));
    }

    static LRESULT CALLBACK StepControlWndProc(
        __in HWND hWnd,
        __in UINT uMsg,
        __in WPARAM wParam,
        __in LPARAM lParam
        )
    {
        WNDPROC pfnOld = reinterpret_cast<WNDPROC>(::GetPropW(hWnd, PROP_OLD_WNDPROC));
        DWORD dwStepMask = static_cast<DWORD>(reinterpret_cast<ULONG_PTR>(::GetPropW(hWnd, PROP_STEP_MASK)));

        switch (uMsg)
        {
        case WM_WINDOWPOSCHANGING:
        {
            WINDOWPOS* pwp = reinterpret_cast<WINDOWPOS*>(lParam);
            if (vpThis && pwp && (pwp->flags & SWP_SHOWWINDOW) && !vpThis->IsAllowed(dwStepMask))
            {
                // 不属于当前步骤：不让它显示出来（thmutil 换页 / 刷新时会显示 WixStdBA 管理的控件）
                pwp->flags &= ~SWP_SHOWWINDOW;
                vpThis->PostFixup();
            }
            break;
        }

        case WM_NCDESTROY:
            ::SetWindowLongPtrW(hWnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(pfnOld));
            ::RemovePropW(hWnd, PROP_OLD_WNDPROC);
            ::RemovePropW(hWnd, PROP_STEP_MASK);
            break;
        }

        return pfnOld ? ::CallWindowProcW(pfnOld, hWnd, uMsg, wParam, lParam) : ::DefWindowProcW(hWnd, uMsg, wParam, lParam);
    }

public:
    CPrimusBAFunctions(
        __in HMODULE hModule
        ) : CBalBaseBAFunctions(hModule)
    {
        m_dwStep = FIRST_STEP;
        m_hwndInstall = NULL;
        m_hwndEula = NULL;
        m_hwndNext = NULL;
        m_hwndBack = NULL;
        m_hwndAgree = NULL;
        m_hwndRefresh = NULL;
        m_fFixupPosted = FALSE;
    }

    ~CPrimusBAFunctions()
    {
        if (vpThis == this)
        {
            vpThis = NULL;
        }
    }

private:
    static CPrimusBAFunctions* vpThis;

    DWORD m_dwStep;
    HWND m_hwndInstall;
    HWND m_hwndEula;
    HWND m_hwndNext;
    HWND m_hwndBack;
    HWND m_hwndAgree;
    HWND m_hwndRefresh;
    BOOL m_fFixupPosted;
};

CPrimusBAFunctions* CPrimusBAFunctions::vpThis = NULL;


HRESULT WINAPI CreateBAFunctions(
    __in HMODULE hModule,
    __in const BA_FUNCTIONS_CREATE_ARGS* pArgs,
    __inout BA_FUNCTIONS_CREATE_RESULTS* pResults
    )
{
    HRESULT hr = S_OK;
    CPrimusBAFunctions* pBAFunctions = NULL;

    pBAFunctions = new CPrimusBAFunctions(hModule);
    ExitOnNull(pBAFunctions, hr, E_OUTOFMEMORY, "Failed to create new CPrimusBAFunctions object.");

    hr = pBAFunctions->OnCreate(pArgs->pEngine, pArgs->pCommand);
    ExitOnFailure(hr, "Failed to call OnCreate CPrimusBAFunctions.");

    pResults->pfnBAFunctionsProc = BalBaseBAFunctionsProc;
    pResults->pvBAFunctionsProcContext = pBAFunctions;
    pBAFunctions = NULL;

LExit:
    ReleaseObject(pBAFunctions);

    return hr;
}
