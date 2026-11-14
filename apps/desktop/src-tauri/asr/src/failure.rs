//! 识别失败的分类：决定换不换模型、这款模型多久之后再用。

/// 失败的种类。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// 免费额度用完（控制台开启“免费额度用完即停”后返回 403 `AllocationQuota.FreeTierOnly`）或账号欠费
    Quota(String),
    /// 这款模型用不了（未开通、无权限、模型下线、参数不被接受）：一天后再试
    Unusable(String),
    /// 网络中断、超时、服务端临时错误：不记账，换下一款继续
    Transient(String),
    /// 这款模型接不了这段录音（如整段识别超过时长或大小上限），没有发出请求：不记账，也不算网络故障
    Unsuited(String),
}

impl Failure {
    pub fn detail(&self) -> &str {
        match self {
            Failure::Quota(d)
            | Failure::Unusable(d)
            | Failure::Transient(d)
            | Failure::Unsuited(d) => d,
        }
    }
}

/// 按服务端返回的错误码（及 HTTP 状态码，WebSocket 时为 None）分类。
pub fn classify(code: &str, status: Option<u16>, message: &str) -> Failure {
    let detail = if message.is_empty() {
        code.to_string()
    } else {
        format!("{code}: {message}")
    };
    let lower = code.to_ascii_lowercase();
    let text = format!("{lower} {}", message.to_ascii_lowercase());
    // 限流（含 Throttling.RateQuota）是临时的，不算额度用完
    if lower.starts_with("throttling") || status == Some(429) {
        return Failure::Transient(detail);
    }
    if text.contains("freetieronly")
        || text.contains("free tier")
        || lower.contains("quota")
        || lower.contains("arrearage")
        || text.contains("insufficient balance")
    {
        return Failure::Quota(detail);
    }
    if status.is_some_and(|s| s == 429 || s >= 500)
        || lower.contains("throttling")
        || lower.contains("ratelimit")
        || lower.contains("rate_limit")
        || lower.contains("internal")
        || lower.contains("timeout")
        || lower.contains("serviceunavailable")
    {
        return Failure::Transient(detail);
    }
    if status.is_some_and(|s| (400..500).contains(&s))
        || lower.contains("accessdenied")
        || lower.contains("access_denied")
        || lower.contains("invalid")
        || lower.contains("notfound")
        || lower.contains("not_found")
        || lower.contains("unsupported")
        || lower.contains("model")
    {
        return Failure::Unusable(detail);
    }
    Failure::Transient(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_tier_only_is_quota() {
        assert!(matches!(
            classify(
                "AllocationQuota.FreeTierOnly",
                Some(403),
                "free tier quota exhausted"
            ),
            Failure::Quota(_)
        ));
        assert!(matches!(
            classify("Arrearage", None, "Access denied"),
            Failure::Quota(_)
        ));
    }

    #[test]
    fn throttling_and_server_errors_are_transient() {
        assert!(matches!(
            classify("Throttling.RateQuota", Some(429), ""),
            Failure::Transient(_)
        ));
        assert!(matches!(
            classify("Throttling", Some(429), ""),
            Failure::Transient(_)
        ));
        assert!(matches!(
            classify("InternalError", Some(500), ""),
            Failure::Transient(_)
        ));
    }

    #[test]
    fn access_and_parameter_errors_are_unusable() {
        assert!(matches!(
            classify("Model.AccessDenied", Some(403), "Model access denied."),
            Failure::Unusable(_)
        ));
        assert!(matches!(
            classify("InvalidParameter", Some(400), ""),
            Failure::Unusable(_)
        ));
        assert!(matches!(
            classify("model_not_supported", Some(400), ""),
            Failure::Unusable(_)
        ));
    }
}
