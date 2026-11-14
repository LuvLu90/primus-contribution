//! 连接百炼：HTTPS（reqwest，跟随系统代理）与 WebSocket（tokio-tungstenite + rustls，系统证书库校验；
//! 同样跟随系统代理：经 HTTP 代理的 CONNECT 隧道连接，识别规则与 reqwest 相同）。

use std::sync::Arc;
use std::time::Duration;

use hyper_util::client::proxy::matcher::Matcher;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

use crate::failure::{Failure, classify};

/// 华北 2（北京）公共地址：免费额度只在北京地域
pub const HOST: &str = "dashscope.aliyuncs.com";

pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 单次 WebSocket 写入的等待上限：连接持续背压时不卡住会话，按临时错误换下一款
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// 发送一条 WebSocket 消息（带超时）
pub async fn send(
    ws: &mut Ws,
    msg: tokio_tungstenite::tungstenite::Message,
) -> Result<(), Failure> {
    use futures_util::SinkExt;
    match tokio::time::timeout(SEND_TIMEOUT, ws.send(msg)).await {
        Err(_) => Err(Failure::Transient("发送超时".into())),
        Ok(Err(e)) => Err(Failure::Transient(format!("连接中断：{e}"))),
        Ok(Ok(())) => Ok(()),
    }
}

/// 关闭 WebSocket（尽力而为，带超时）
pub async fn close(ws: &mut Ws) {
    let _ = tokio::time::timeout(SEND_TIMEOUT, ws.close(None)).await;
}

pub struct Net {
    key: String,
    http: reqwest::Client,
    tls: Arc<rustls::ClientConfig>,
    proxy: Matcher,
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
            proxy: Matcher::from_system(),
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
        let connect = async {
            let tcp = self.tcp().await?;
            tokio_tungstenite::client_async_tls_with_config(
                req,
                tcp,
                None,
                Some(Connector::Rustls(self.tls.clone())),
            )
            .await
            .map_err(WsError::Ws)
        };
        match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
            Err(_) => Err(Failure::Transient("连接超时".into())),
            Ok(Ok((ws, _))) => Ok(ws),
            Ok(Err(WsError::Proxy(e))) => Err(Failure::Transient(format!("代理连接失败：{e}"))),
            Ok(Err(WsError::Ws(tokio_tungstenite::tungstenite::Error::Http(res)))) => {
                let status = res.status().as_u16();
                let json: serde_json::Value = res
                    .body()
                    .as_deref()
                    .and_then(|b| serde_json::from_slice(b).ok())
                    .unwrap_or(serde_json::Value::Null);
                let (code, message) = error_fields(&json);
                Err(classify(&code, Some(status), &message))
            }
            Ok(Err(WsError::Ws(e))) => Err(Failure::Transient(format!("连接失败：{e}"))),
        }
    }

    /// 到百炼的 TCP 连接：系统设置了 HTTP 代理时经代理的 CONNECT 隧道，否则直连
    async fn tcp(&self) -> Result<TcpStream, WsError> {
        let dst: tokio_tungstenite::tungstenite::http::Uri = format!("https://{HOST}")
            .parse()
            .map_err(|e: tokio_tungstenite::tungstenite::http::uri::InvalidUri| {
                WsError::Proxy(e.to_string())
            })?;
        let Some(proxy) = self.proxy.intercept(&dst) else {
            return TcpStream::connect((HOST, 443))
                .await
                .map_err(|e| WsError::Ws(e.into()));
        };
        let uri = proxy.uri();
        // 只支持 HTTP 代理（与浏览器的“代理服务器”设置一致）；SOCKS 等其他代理不经隧道，直连
        if !matches!(uri.scheme_str(), Some("http") | None) {
            return TcpStream::connect((HOST, 443))
                .await
                .map_err(|e| WsError::Ws(e.into()));
        }
        let host = uri.host().unwrap_or_default();
        let port = uri.port_u16().unwrap_or(80);
        let mut tcp = TcpStream::connect((host, port))
            .await
            .map_err(|e| WsError::Proxy(e.to_string()))?;
        let auth = proxy
            .basic_auth()
            .and_then(|v| v.to_str().ok())
            .map(|v| format!("Proxy-Authorization: {v}\r\n"))
            .unwrap_or_default();
        tcp.write_all(connect_request(&auth).as_bytes())
            .await
            .map_err(|e| WsError::Proxy(e.to_string()))?;
        read_connect_response(&mut tcp).await?;
        Ok(tcp)
    }
}

enum WsError {
    Proxy(String),
    Ws(tokio_tungstenite::tungstenite::Error),
}

fn connect_request(auth: &str) -> String {
    format!("CONNECT {HOST}:443 HTTP/1.1\r\nHost: {HOST}:443\r\n{auth}\r\n")
}

/// 读代理对 CONNECT 的响应头（到空行为止，不多读隧道里的数据），状态码须为 2xx
async fn read_connect_response<S: AsyncReadExt + Unpin>(s: &mut S) -> Result<(), WsError> {
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 {
            return Err(WsError::Proxy("代理响应头过长".into()));
        }
        let n = s
            .read(&mut byte)
            .await
            .map_err(|e| WsError::Proxy(e.to_string()))?;
        if n == 0 {
            return Err(WsError::Proxy("代理关闭了连接".into()));
        }
        head.push(byte[0]);
    }
    let status = String::from_utf8_lossy(&head);
    let code = status.split_whitespace().nth(1).unwrap_or_default();
    if code.starts_with('2') {
        Ok(())
    } else {
        Err(WsError::Proxy(format!("代理拒绝 CONNECT：{code}")))
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
    fn connect_request_shape() {
        assert_eq!(
            connect_request(""),
            "CONNECT dashscope.aliyuncs.com:443 HTTP/1.1\r\nHost: dashscope.aliyuncs.com:443\r\n\r\n"
        );
        assert!(
            connect_request("Proxy-Authorization: Basic eDp5\r\n").contains("Basic eDp5\r\n\r\n")
        );
    }

    #[tokio::test]
    async fn connect_response_status() {
        let mut ok: &[u8] = b"HTTP/1.1 200 Connection established\r\n\r\nTLS";
        assert!(read_connect_response(&mut ok).await.is_ok());
        // 不多读隧道里的数据
        assert_eq!(ok, b"TLS");
        let mut denied: &[u8] = b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n";
        assert!(read_connect_response(&mut denied).await.is_err());
        let mut closed: &[u8] = b"HTTP/1.1 200";
        assert!(read_connect_response(&mut closed).await.is_err());
    }

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
