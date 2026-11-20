//! 系统通知（ADR 0023）：Windows 上用 WinRT Toast，应用 ID 与开始菜单快捷方式的 `System.AppUserModel.ID`
//! （`Primus.wxs`）、`tauri.conf.json` 的 identifier 一致，通知归属到“乾元 Primus”。
//!
//! - Toast 本身静音（`<audio silent="true"/>`）：提示音由前端按设置播放，完成 / 需要处理 / 出错各是一种声音，
//!   不与系统通知音叠在一起。
//! - 同一个会话的通知用同一个 Tag 替换（操作中心里每个会话只留最新一条）。
//! - 点击通知触发 `Activated`，回调收到发送时给的 `tag`。只对本进程运行期间发出的通知有效；
//!   应用已退出后点击操作中心里的旧通知，由系统按快捷方式启动应用。
//! - 开发模式没有开始菜单快捷方式时系统不显示通知（不报错），提示音照常。
//! - 其他平台暂不显示系统通知（第 20 章，P3 适配）。

/// 应用的 AppUserModelID（与 `tauri.conf.json` 的 identifier、MSI 快捷方式一致）。
pub(crate) const APP_USER_MODEL_ID: &str = "com.primus.desktop";

/// 通知分组：本应用的全部 Toast 同一组。
#[cfg_attr(not(windows), allow(dead_code))]
const GROUP: &str = "primus";

/// Toast 的 Tag 最长 64 个字符：超出时截断（前端的标签 ID 远短于此）。
#[cfg_attr(not(windows), allow(dead_code))]
const TAG_MAX: usize = 64;

/// 转义 XML 文本中的特殊字符（标题与正文来自对话内容）。
pub(crate) fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 不允许的控制字符（制表、换行、回车除外）去掉，否则整份 Toast 解析失败
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

/// Toast 的 XML：标题一行、正文一行，静音。
pub(crate) fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><audio silent=\"true\"/></toast>",
        xml_escape(title),
        xml_escape(body)
    )
}

#[cfg_attr(not(windows), allow(dead_code))]
fn short_tag(tag: &str) -> String {
    tag.chars().take(TAG_MAX).collect()
}

/// 进程启动时声明应用 ID：不是从快捷方式启动（更新后重新打开、命令行启动）时，通知与任务栏仍归属本应用。
pub(crate) fn set_app_user_model_id() {
    #[cfg(windows)]
    {
        let id: Vec<u16> = APP_USER_MODEL_ID
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: 传入以 NUL 结尾的 UTF-16 字符串，调用期间有效
        let hr = unsafe {
            windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(id.as_ptr())
        };
        if hr < 0 {
            eprintln!("[notify] 设置应用 ID 失败：0x{hr:08X}");
        }
    }
}

/// 显示一条通知；`on_activate` 在用户点击通知时（系统线程上）调用。
#[cfg(windows)]
pub(crate) fn show(
    title: &str,
    body: &str,
    tag: &str,
    on_activate: impl Fn() + Send + 'static,
) -> Result<(), String> {
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    use windows::core::{HSTRING, IInspectable};

    let run = || -> windows::core::Result<()> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        let tag = short_tag(tag);
        if !tag.is_empty() {
            toast.SetTag(&HSTRING::from(tag))?;
        }
        toast.SetGroup(&HSTRING::from(GROUP))?;
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            move |_, _| {
                on_activate();
                Ok(())
            },
        ))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_USER_MODEL_ID))?
            .Show(&toast)
    };
    run().map_err(|e| format!("显示系统通知失败：{e}"))
}

/// 其他平台暂不显示系统通知。
#[cfg(not(windows))]
pub(crate) fn show(
    _title: &str,
    _body: &str,
    _tag: &str,
    _on_activate: impl Fn() + Send + 'static,
) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_xml_and_drops_control_chars() {
        assert_eq!(
            xml_escape("a<b>&\"c\"'d'\u{1}\n"),
            "a&lt;b&gt;&amp;&quot;c&quot;&apos;d&apos;\n"
        );
    }

    #[test]
    fn toast_is_silent_with_title_and_body() {
        let xml = toast_xml("任务已完成 · 修<登录>", "改好了");
        assert!(xml.contains("<text>任务已完成 · 修&lt;登录&gt;</text><text>改好了</text>"));
        assert!(xml.contains("<audio silent=\"true\"/>"));
    }

    #[test]
    fn tag_is_capped() {
        assert_eq!(short_tag(&"x".repeat(100)).len(), TAG_MAX);
        assert_eq!(short_tag("tab-1"), "tab-1");
    }
}
