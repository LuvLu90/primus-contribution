//! 连接百炼：HTTPS（reqwest，跟随系统代理）与 WebSocket（tokio-tungstenite + rustls，系统证书库校验）。

use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

use crate::failure::{Failure, classify};

/// 华北 2（北京）公共地址：免费额度只在北京地域
pub const HOST: &str = "dashscope.aliyuncs.com";

pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Net {
    key: String,
    http: reqwest::Client,
    tls: Arc<rustls::ClientConfig>,
}

impl Net {
    pub fn new(key: String) -> Result<Self, String> {
        // 与薄壳其他 rustls 用法一致：没有默认加密实现时装上 ring
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        use rustls_platform_verifier::ConfigVerifierExt;
        let tls = rustls::ClientConfig::with_platform_verifier().map_err(|e| e.to_string())?;
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            key,
            http,
            tls: Arc::new(tls),
        })
    }

    fn bearer(&self) -> String {
        format!("Bearer {}", self.key)
    }

    /// POST JSON，返回响应 JSON；非 2xx 按错误码分类
    pub async fn post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, Failure> {
        let res = self
            .http
            .post(format!("https://{HOST}{path}"))
            .header("Authorization", self.bearer())
            .header("Content-Type", "application/json")
            .body(serde_json::to_vec(body).unwrap_or_default())
            .send()
            .await
            .map_err(|e| Failure::Transient(format!("请求失败：{e}")))?;
        let status = res.status().as_u16();
        let bytes = res
            .bytes()
            .await
            .map_err(|e| Failure::Transient(format!("读取响应失败：{e}")))?;
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        if (200..300).contains(&status) {
            return Ok(json);
        }
        let (code, message) = error_fields(&json);
        Err(classify(&code, Some(status), &message))
    }

    /// 打开 WebSocket；握手被拒（鉴权、额度、模型）时按响应体的错误码分类
    pub async fn ws(
        &self,
        path: &str,
        extra: &[(&'static str, &'static str)],
    ) -> Result<Ws, Failure> {
        let mut req = format!("wss://{HOST}{path}")
            .into_client_request()
            .map_err(|e| Failure::Unusable(e.to_string()))?;
        let auth =
            HeaderValue::from_str(&self.bearer()).map_err(|e| Failure::Unusable(e.to_string()))?;
        req.headers_mut().insert("Authorization", auth);
        for (name, value) in extra {
            req.headers_mut()
                .insert(*name, HeaderValue::from_static(value));
        }
        let connect = tokio_tungstenite::connect_async_tls_with_config(
            req,
            None,
            false,
            Some(Connector::Rustls(self.tls.clone())),
        );
        match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
            Err(_) => Err(Failure::Transient("连接超时".into())),
            Ok(Ok((ws, _))) => Ok(ws),
            Ok(Err(tokio_tungstenite::tungstenite::Error::Http(res))) => {
                let status = res.status().as_u16();
                let json: serde_json::Value = res
                    .body()
                    .as_deref()
                    .and_then(|b| serde_json::from_slice(b).ok())
                    .unwrap_or(serde_json::Value::Null);
                let (code, message) = error_fields(&json);
                Err(classify(&code, Some(status), &message))
            }
            Ok(Err(e)) => Err(Failure::Transient(format!("连接失败：{e}"))),
        }
    }
}

/// 错误响应里的错误码与说明：DashScope 为 `{code, message}`，兼容模式为 `{error: {code, message}}`
pub fn error_fields(json: &serde_json::Value) -> (String, String) {
    let obj = json.get("error").filter(|e| e.is_object()).unwrap_or(json);
    let s = |k: &str| {
        obj.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    (s("code"), s("message"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn error_fields_both_shapes() {
        assert_eq!(
            error_fields(&json!({"code": "AllocationQuota.FreeTierOnly", "message": "m"})),
            ("AllocationQuota.FreeTierOnly".into(), "m".into())
        );
        assert_eq!(
            error_fields(&json!({"error": {"code": "model_not_found", "message": "x"}})),
            ("model_not_found".into(), "x".into())
        );
        assert_eq!(
            error_fields(&serde_json::Value::Null),
            (String::new(), String::new())
        );
    }
}
