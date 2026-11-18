//! 对话内生成的图片（ADR 0018）：Core 的 primus-imagegen 扩展把图片写在 `data/users/<SID>/images/<会话>/`，
//! 薄壳只负责“保存到…”（`image_save`）：确认源文件确实是该目录内的图片，再复制到用户在系统对话框里选的位置。
//! 薄壳不调用图片服务、不理解生成过程。

use std::fs;
use std::path::{Path, PathBuf};

/// 可以保存的图片扩展名（primus-imagegen 按文件头写出的格式）。
const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp"];

/// 小写扩展名；不是图片时返回 None。
pub(crate) fn image_ext(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_EXT.contains(&ext.as_str()).then_some(ext)
}

/// 校验要保存的图片：必须是 `images_dir` 内（按真实路径比较，链接指向目录外也拒绝）的普通图片文件。
pub(crate) fn check_generated(images_dir: &Path, path: &str) -> Result<PathBuf, String> {
    let raw = Path::new(path);
    if path.is_empty() || !raw.is_absolute() {
        return Err("路径格式不正确".into());
    }
    let root = fs::canonicalize(images_dir).map_err(|_| "图片已不存在".to_string())?;
    let real = fs::canonicalize(raw).map_err(|_| "图片已不存在".to_string())?;
    if !real.starts_with(&root) || real == root {
        return Err("只能保存乾元生成的图片".into());
    }
    if !fs::metadata(&real).map(|m| m.is_file()).unwrap_or(false) {
        return Err("图片已不存在".into());
    }
    if image_ext(&real).is_none() {
        return Err("不是图片文件".into());
    }
    Ok(real)
}

/// 另存为对话框里的默认文件名：`<工具调用>-<时间戳>-<序号>.png` → `primus-image-<时间戳>-<序号>.png`；
/// 不是这个格式时用原文件名。
pub(crate) fn default_file_name(src: &Path) -> String {
    let ext = image_ext(src).unwrap_or_else(|| "png".into());
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
    let mut parts = stem.rsplitn(3, '-');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(index), Some(stamp), Some(_))
            if !index.is_empty()
                && !stamp.is_empty()
                && index.bytes().all(|b| b.is_ascii_digit())
                && stamp.bytes().all(|b| b.is_ascii_digit()) =>
        {
            format!("primus-image-{stamp}-{index}.{ext}")
        }
        _ if !stem.is_empty() => format!("{stem}.{ext}"),
        _ => format!("primus-image.{ext}"),
    }
}

/// 复制到用户选的位置；选的就是源文件本身时什么也不做。
pub(crate) fn copy_to(src: &Path, dest: &Path) -> Result<(), String> {
    if fs::canonicalize(dest).is_ok_and(|d| d == src) {
        return Ok(());
    }
    fs::copy(src, dest)
        .map(|_| ())
        .map_err(|e| format!("保存图片失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "primus-images-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn only_generated_images_can_be_saved() {
        let tmp = TempDir::new();
        let images = tmp.0.join("images");
        fs::create_dir_all(images.join("s1")).unwrap();
        let png = images.join("s1").join("call_1-1000-1.png");
        fs::write(&png, b"\x89PNG").unwrap();
        let outside = tmp.0.join("secret.png");
        fs::write(&outside, b"x").unwrap();
        let text = images.join("s1").join("a.txt");
        fs::write(&text, b"x").unwrap();

        let ok = check_generated(&images, png.to_str().unwrap()).unwrap();
        assert_eq!(ok, fs::canonicalize(&png).unwrap());
        assert!(check_generated(&images, outside.to_str().unwrap()).is_err());
        assert!(check_generated(&images, text.to_str().unwrap()).is_err());
        assert!(check_generated(&images, images.to_str().unwrap()).is_err());
        assert!(check_generated(&images, "relative/a.png").is_err());
        assert!(check_generated(&images, "").is_err());
        // 经 `..` 跳出图片目录
        let escape = images.join("s1").join("..").join("..").join("secret.png");
        assert!(check_generated(&images, escape.to_str().unwrap()).is_err());
        // 不存在
        let missing = images.join("s1").join("none.png");
        assert_eq!(
            check_generated(&images, missing.to_str().unwrap()).unwrap_err(),
            "图片已不存在"
        );
    }

    #[test]
    fn default_names() {
        assert_eq!(
            default_file_name(Path::new("/d/call_1-1700000000000-2.png")),
            "primus-image-1700000000000-2.png"
        );
        assert_eq!(default_file_name(Path::new("/d/photo.JPG")), "photo.jpg");
        assert_eq!(default_file_name(Path::new("/d/a-b-c.webp")), "a-b-c.webp");
    }

    #[test]
    fn copy_writes_destination() {
        let tmp = TempDir::new();
        let src = tmp.0.join("a.png");
        fs::write(&src, b"\x89PNG data").unwrap();
        let dest = tmp.0.join("b.png");
        copy_to(&fs::canonicalize(&src).unwrap(), &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"\x89PNG data");
        // 选的是源文件本身：不报错、内容不变
        let real = fs::canonicalize(&src).unwrap();
        copy_to(&real, &real).unwrap();
        assert_eq!(fs::read(&src).unwrap(), b"\x89PNG data");
    }
}
