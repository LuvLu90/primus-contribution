//! 构建时把百炼密钥（环境变量 PRIMUS_ASR_KEY）混淆后写进 OUT_DIR/key.rs：二进制里不出现明文。
//! 没有设置时生成空密钥，运行时语音转文字不可用（开发构建、CI 测试）。
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};

fn main() {
    println!("cargo:rerun-if-env-changed=PRIMUS_ASR_KEY");
    let key = std::env::var("PRIMUS_ASR_KEY").unwrap_or_default();
    let key = key.trim().as_bytes();
    let mut mask = Vec::with_capacity(32);
    while mask.len() < 32 {
        let mut h = RandomState::new().build_hasher();
        h.write_usize(mask.len());
        mask.extend_from_slice(&h.finish().to_le_bytes());
    }
    let data: Vec<u8> = key
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ mask[i % mask.len()])
        .collect();
    let out = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("key.rs");
    std::fs::write(
        out,
        format!(
            "const KEY_MASK: [u8; 32] = {mask:?};\nconst KEY_DATA: [u8; {}] = {data:?};\n",
            data.len()
        ),
    )
    .unwrap();
}
