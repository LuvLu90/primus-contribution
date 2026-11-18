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

use crate::providers::{Api, Provider};

/// 内置渠道 ID（也是名称）。
pub(crate) const SEED_PROVIDER_ID: &str = "ioply";

/// 内置渠道协议。
const SEED_API: Api = Api::OpenAiResponses;

/// 内置渠道接口地址：内置地址只写在这里，更换时只改这一处。
const SEED_BASE_URL: &str = "https://api.690990.xyz/v1";

/// 内置渠道密钥（简单加密：按 [`KEY_MASK`] 循环异或后转十六进制），运行时由 [`api_key`] 还原。
/// 更换密钥时只改这一行，生成新值：
/// `python3 -c "import sys;m=b'primus-builtin';k=sys.argv[1].encode();print(bytes(b^m[i%len(m)] for i,b in enumerate(k)).hex())" <新密钥>`
/// 并把旧密钥的摘要追加到 [`LEGACY_API_KEY_SHA256`]。
pub(crate) const BUILTIN_API_KEY: &str = "031944153332475b4702382c072546252a174c1d6a0b3e1302360e141634193a3e1a1b17040e5d1e5f163e20055e3d3f5b271f";

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
const LEGACY_API_KEY_SHA256: &[&str] =
    &["54a2f0dbde8b80d465fb9272ef0f10ad8bec1075f1994bad12d430fbc8664fbd"];

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
        assert_ne!(key, api_key());
        assert!(IMAGE_BASE_URL.starts_with("https://") && !IMAGE_BASE_URL.ends_with('/'));
    }
}
