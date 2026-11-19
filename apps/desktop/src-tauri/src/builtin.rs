//! 内置渠道（种子）：首次启动（`providers.json` 还不存在）时写入一个预置渠道与其密钥。
//! 未被修改且启用时它是隐藏的系统渠道；用户修改或停用后按普通渠道显示并继续由用户管理。
//!
//! - 只在渠道文件不存在时写一次：用户修改或停用它之后不会被覆盖，也不会再次隐藏。
//! - 密钥只有下面一个常量：种子写入时存进 DPAPI 保险库（`provider:ioply`），`models.json` 里只放取密钥命令。
//! - 模型清单起初为空；只要渠道仍是种子配置且清单为空，每次启动都会在后台重试获取（`lib.rs`）。
//!   已停用的渠道改回种子配置并保存时也会立即后台获取，无需重启。
//! - 内置地址只写在 [`SEED_BASE_URL`] 一处：更换时只改它。自动更新后，名称与协议仍是种子配置的 ioply
//!   只要地址与它不同，启动时就迁移到当前地址（清空模型清单后重新获取），旧地址不需要保留；
//!   保险库里的旧内置密钥同步为当前常量；用户自己换过的密钥不覆盖。
//! - 内置图片生成服务（ADR 0018）的地址与密钥也只在本文件各一处：[`IMAGE_BASE_URL`]、[`BUILTIN_IMAGE_API_KEY`]。
//! - 内置联网搜索服务（ADR 0020）同样只在本文件：[`SEARCH_BASE_URL`]、[`BUILTIN_SEARCH_API_KEYS`]（两把，轮流使用）。

use crate::providers::{Api, Provider};

/// 内置渠道 ID（也是名称）。
pub(crate) const SEED_PROVIDER_ID: &str = "ioply";

/// 内置渠道协议。
const SEED_API: Api = Api::OpenAiResponses;

/// 内置渠道接口地址：内置地址只写在这里，更换时只改这一处。
const SEED_BASE_URL: &str = "https://agent.690990.xyz/v1";

/// 内置渠道密钥（简单加密：按 [`KEY_MASK`] 循环异或后转十六进制），运行时由 [`api_key`] 还原。
/// 更换密钥时只改这一行，生成新值：
/// `python3 -c "import sys;m=b'primus-builtin';k=sys.argv[1].encode();print(bytes(b^m[i%len(m)] for i,b in enumerate(k)).hex())" <新密钥>`
/// 并把旧密钥的摘要追加到 [`LEGACY_API_KEY_SHA256`]。
pub(crate) const BUILTIN_API_KEY: &str = "0319440521385c380f3309265b0f37315a02191a413a1d0e0b01030804082b040d1f6932463b2d121e5c1f213c5e074b7f572d";

/// 密钥加密用的异或掩码。
const KEY_MASK: &[u8] = b"primus-builtin";

/// 还原内置渠道密钥。
pub(crate) fn api_key() -> String {
    decode(BUILTIN_API_KEY)
}

/// 按 [`KEY_MASK`] 循环异或还原十六进制编码的内置密钥。
fn decode(hex: &str) -> String {
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .zip(KEY_MASK.iter().cycle())
        .map(|(i, m)| u8::from_str_radix(&hex[i..i + 2], 16).expect("内置密钥不是十六进制") ^ m)
        .collect();
    String::from_utf8(bytes).expect("内置密钥不是 UTF-8")
}

/// 历史版本用过的内置密钥的 SHA-256（小写十六进制）。只存摘要，内置密钥只有 [`BUILTIN_API_KEY`] 一处（加密存放）。
/// 保险库里是这些密钥（或没有密钥）时同步为 [`api_key`]，其他值视为用户自己换的密钥，不覆盖。
/// 更换密钥时把旧密钥的摘要追加到这里。
const LEGACY_API_KEY_SHA256: &[&str] = &[
    "54a2f0dbde8b80d465fb9272ef0f10ad8bec1075f1994bad12d430fbc8664fbd",
    "a2a9d8130ffa1b7472e72c01400cd61fc278b3784f19d7dd8b28cf108028225e",
];

/// 测试用的“历史内置密钥”：测试里不能出现真实历史密钥，用它代替。
#[cfg(test)]
pub(crate) const TEST_LEGACY_API_KEY: &str = "sk-legacy-builtin-for-tests";

/// 是否历史版本的内置密钥（按摘要比较）。
pub(crate) fn is_legacy_api_key(key: &str) -> bool {
    #[cfg(test)]
    if key == TEST_LEGACY_API_KEY {
        return true;
    }
    LEGACY_API_KEY_SHA256.contains(&crate::updater::sha256_hex(key.as_bytes()).as_str())
}

/// 内置图片生成服务（ADR 0018，OpenAI Images 兼容）：地址明文，更换时只改这一处；
/// 经环境变量 `PRIMUS_IMAGE_BASE_URL` 传给 Core 的 primus-imagegen 扩展。
pub(crate) const IMAGE_BASE_URL: &str = "https://image.a-j.app/v1";

/// 内置图片生成服务密钥（与 [`BUILTIN_API_KEY`] 同样按 [`KEY_MASK`] 循环异或后转十六进制），运行时由 [`image_api_key`] 还原。
/// 只经 `Primus.exe --secret builtin:image` 交给 Core 作业内的调用方，不写入任何文件。更换时只改这一行（生成命令同上）。
pub(crate) const BUILTIN_IMAGE_API_KEY: &str = "0319441806165f4f130b0916515f4217590f4445195746080e420d594340515d13121b00445c5841472c2f3a2a00381d400b195e2d2b255e47163c152a2269183f003c1b3818211b135c072640282d045935190d";

/// 还原内置图片生成服务密钥。
pub(crate) fn image_api_key() -> String {
    decode(BUILTIN_IMAGE_API_KEY)
}

/// 内置联网搜索服务（ADR 0020，LangSearch Web Search API）：地址明文，更换时只改这一处；
/// 经环境变量 `PRIMUS_SEARCH_BASE_URL` 传给 Core 的 primus-web 扩展（请求 `<地址>/web-search`）。
pub(crate) const SEARCH_BASE_URL: &str = "https://api.langsearch.com/v1";

/// 内置联网搜索服务密钥（两把，与 [`BUILTIN_API_KEY`] 同样按 [`KEY_MASK`] 循环异或后转十六进制），运行时由
/// [`search_api_keys`] 还原。只经 `Primus.exe --secret builtin:search` 交给 Core 作业内的调用方（每行一把），
/// 不写入任何文件；primus-web 轮流使用，一把限流或失效时换另一把。更换时只改这里（生成命令同上）。
pub(crate) const BUILTIN_SEARCH_API_KEYS: [&str; 2] = [
    "0319440f104a1f07405f0941505e48460b5f444a1e5a435c0e115a0d42170b5f14401b",
    "0319445b14151550460f0e17590a12460c54404a1e52430a09470b5d4146595b144649",
];

/// 还原内置联网搜索服务密钥。
pub(crate) fn search_api_keys() -> Vec<String> {
    BUILTIN_SEARCH_API_KEYS.iter().map(|k| decode(k)).collect()
}

/// 旧版内置模型配置在保险库中的令牌 ID：启动时删除（迁移）。
pub(crate) const LEGACY_TOKEN_ID: &str = "model-token";

/// 内置渠道（模型清单为空，启动后获取）。
pub(crate) fn seed_provider() -> Provider {
    Provider {
        id: SEED_PROVIDER_ID.to_owned(),
        name: SEED_PROVIDER_ID.to_owned(),
        api: SEED_API,
        base_url: SEED_BASE_URL.to_owned(),
        enabled: true,
        models: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_provider_is_valid() {
        let p = seed_provider();
        crate::providers::check_provider(&p).unwrap();
        assert!(p.models.is_empty() && p.enabled);
        assert!(
            !serde_json::to_string(&p)
                .unwrap()
                .contains(api_key().as_str())
        );
    }

    #[test]
    fn api_key_is_decoded() {
        let key = api_key();
        assert!(key.starts_with("sk-"));
        assert!(
            !BUILTIN_API_KEY.contains(key.as_str()),
            "源码中不出现明文密钥"
        );
    }

    #[test]
    fn image_api_key_is_decoded() {
        let key = image_api_key();
        assert!(key.starts_with("sk-"));
        assert!(!BUILTIN_IMAGE_API_KEY.contains(key.as_str()));
        assert!(key != api_key(), "内置图片密钥不能与对话密钥相同");
        assert!(IMAGE_BASE_URL.starts_with("https://") && !IMAGE_BASE_URL.ends_with('/'));
    }

    #[test]
    fn search_api_keys_are_decoded() {
        let keys = search_api_keys();
        assert_eq!(keys.len(), 2);
        assert!(keys[0] != keys[1], "两把内置搜索密钥不能相同");
        for (key, hex) in keys.iter().zip(BUILTIN_SEARCH_API_KEYS) {
            assert!(key.starts_with("sk-"));
            // 每行一把交给扩展：密钥里不能有换行等控制字符
            assert!(!key.chars().any(char::is_control));
            assert!(!hex.contains(key.as_str()), "源码中不出现明文密钥");
            assert!(key != &api_key(), "内置搜索密钥不能与对话密钥相同");
            assert!(key != &image_api_key(), "内置搜索密钥不能与图片密钥相同");
        }
        assert!(SEARCH_BASE_URL.starts_with("https://") && !SEARCH_BASE_URL.ends_with('/'));
    }
}
