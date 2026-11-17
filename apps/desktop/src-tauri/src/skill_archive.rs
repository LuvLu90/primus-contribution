//! 技能压缩包（zip）的安全解压（ADR 0017）：只解到给定的新目录，不信任压缩包里的任何路径与属性。
//!
//! - 只读中央目录：本地文件头只用来定位数据（大小以中央目录为准，兼容带数据描述符的条目）。
//! - 条目名必须是 UTF-8 相对路径：拒绝绝对路径、盘符、`..` / `.` 段、空段、反斜杠、冒号（NTFS 备用数据流）、
//!   控制字符、Windows 保留名与不合法字符、以点或空格结尾的段；同名（Windows 上不区分大小写）条目拒绝。
//! - 符号链接条目（Unix 属性）跳过不解；加密、ZIP64、分卷与 stored / deflate 以外的压缩方式拒绝。
//! - 上限：压缩包 [`MAX_ARCHIVE_BYTES`]、条目 [`MAX_ENTRIES`] 个、单个文件 [`MAX_FILE_BYTES`]、
//!   合计 [`MAX_TOTAL_BYTES`]（解压前按中央目录检查，解压时按实际字节再检查），每个文件校验 CRC-32。
//! - 文件用 `create_new` 创建，不覆盖、不跟随已存在的链接。

use std::fmt;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// 压缩包本身最多的字节数。
pub(crate) const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
/// 最多的条目数（含目录）。
pub(crate) const MAX_ENTRIES: usize = 5_000;
/// 单个文件解压后最多的字节数。
pub(crate) const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// 全部文件解压后合计最多的字节数。
pub(crate) const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
/// 条目名（相对路径）最长的字节数。
const MAX_NAME_BYTES: usize = 1024;

const EOCD_SIG: u32 = 0x0605_4b50;
const CDH_SIG: u32 = 0x0201_4b50;
const LFH_SIG: u32 = 0x0403_4b50;

/// 解压失败的原因（文案可直接显示）。
#[derive(Debug)]
pub(crate) enum ArchiveError {
    /// 不是 zip、结构损坏或使用了不支持的特性
    Invalid(String),
    /// 条目名不安全
    UnsafeName(String),
    /// 超过上限
    TooLarge(String),
    /// CRC 或大小与中央目录不符
    Corrupt(String),
    Io(io::Error),
}

impl fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(m) => write!(f, "压缩包无法读取：{m}"),
            Self::UnsafeName(n) => write!(f, "压缩包里有不安全的路径：{n}"),
            Self::TooLarge(m) => write!(f, "压缩包超出限制：{m}"),
            Self::Corrupt(n) => write!(f, "压缩包已损坏：{n}"),
            Self::Io(e) => write!(f, "解压失败：{e}"),
        }
    }
}

impl std::error::Error for ArchiveError {}

impl From<io::Error> for ArchiveError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// 解压结果。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Extracted {
    /// 写出的文件数
    pub(crate) files: usize,
    /// 跳过的符号链接条目数
    pub(crate) skipped_links: usize,
}

/// 中央目录里的一条记录（只取用到的字段）。
struct Entry {
    name: String,
    method: u16,
    flags: u16,
    crc: u32,
    compressed: u64,
    size: u64,
    local_offset: u64,
    is_dir: bool,
    is_link: bool,
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn invalid(m: &str) -> ArchiveError {
    ArchiveError::Invalid(m.to_owned())
}

/// 读中央目录。
fn read_central_directory(data: &[u8]) -> Result<Vec<Entry>, ArchiveError> {
    if data.len() < 22 {
        return Err(invalid("不是 zip 文件"));
    }
    // 结束记录在末尾 22 字节 + 最多 65535 字节注释之内，从后往前找。归档注释里也可能出现签名字节，
    // 所以候选记录的注释长度须正好到文件末尾，不符就继续往前找；都不符时退而取注释长度不越界的（末尾有多余字节的包）
    let earliest = data.len().saturating_sub(22 + 0xFFFF);
    let candidates = || {
        (earliest..=data.len() - 22)
            .rev()
            .filter(|&i| u32_at(data, i) == Some(EOCD_SIG))
            .map(|i| (i, i + 22 + usize::from(u16_at(data, i + 20).unwrap_or(0))))
    };
    let eocd = candidates()
        .find(|&(_, end)| end == data.len())
        .or_else(|| candidates().find(|&(_, end)| end <= data.len()))
        .map(|(i, _)| i)
        .ok_or_else(|| invalid("不是 zip 文件"))?;
    let disk = u16_at(data, eocd + 4).unwrap_or(1);
    let cd_disk = u16_at(data, eocd + 6).unwrap_or(1);
    let count_disk = u16_at(data, eocd + 8).unwrap_or(0);
    let count = u16_at(data, eocd + 10).unwrap_or(0);
    let cd_size = u32_at(data, eocd + 12).unwrap_or(0);
    let cd_offset = u32_at(data, eocd + 16).unwrap_or(0);
    if disk != 0 || cd_disk != 0 || count_disk != count {
        return Err(invalid("不支持分卷压缩包"));
    }
    if count == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
        return Err(invalid("不支持 ZIP64 格式"));
    }
    if usize::from(count) > MAX_ENTRIES {
        return Err(ArchiveError::TooLarge(format!("条目超过 {MAX_ENTRIES} 个")));
    }
    let start = cd_offset as usize;
    let end = start
        .checked_add(cd_size as usize)
        .filter(|&e| e <= eocd)
        .ok_or_else(|| invalid("中央目录越界"))?;
    let cd = &data[start..end];
    let mut entries = Vec::with_capacity(usize::from(count));
    let mut at = 0usize;
    for _ in 0..count {
        if u32_at(cd, at) != Some(CDH_SIG) {
            return Err(invalid("中央目录损坏"));
        }
        let field = |off: usize| u16_at(cd, at + off).ok_or_else(|| invalid("中央目录损坏"));
        let field32 = |off: usize| u32_at(cd, at + off).ok_or_else(|| invalid("中央目录损坏"));
        let made_by = field(4)?;
        let flags = field(8)?;
        let method = field(10)?;
        let crc = field32(16)?;
        let compressed = field32(20)?;
        let size = field32(24)?;
        let name_len = usize::from(field(28)?);
        let extra_len = usize::from(field(30)?);
        let comment_len = usize::from(field(32)?);
        let external = field32(38)?;
        let local_offset = field32(42)?;
        let name_bytes = cd
            .get(at + 46..at + 46 + name_len)
            .ok_or_else(|| invalid("中央目录损坏"))?;
        if compressed == 0xFFFF_FFFF || size == 0xFFFF_FFFF || local_offset == 0xFFFF_FFFF {
            return Err(invalid("不支持 ZIP64 格式"));
        }
        let name = std::str::from_utf8(name_bytes)
            .map_err(|_| {
                ArchiveError::UnsafeName(String::from_utf8_lossy(name_bytes).into_owned())
            })?
            .to_owned();
        // 创建系统为 Unix（3）或 OS X（19）时外部属性高 16 位是文件类型：0o120000 为符号链接
        let unix_mode = if matches!(made_by >> 8, 3 | 19) {
            external >> 16
        } else {
            0
        };
        let is_link = unix_mode & 0o170_000 == 0o120_000;
        let is_dir = name.ends_with('/') || unix_mode & 0o170_000 == 0o040_000;
        entries.push(Entry {
            name,
            method,
            flags,
            crc,
            compressed: u64::from(compressed),
            size: u64::from(size),
            local_offset: u64::from(local_offset),
            is_dir,
            is_link,
        });
        at += 46 + name_len + extra_len + comment_len;
    }
    Ok(entries)
}

/// Windows 保留的设备名（不区分大小写，带扩展名也算）。
fn is_reserved_windows_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ((stem.starts_with("COM") || stem.starts_with("LPT"))
        // 按字符数：上标数字在 UTF-8 中占两个字节
        && stem.chars().count() == 4
        && stem[3..]
            .chars()
            .all(|c| c.is_ascii_digit() || "¹²³".contains(c)))
}

/// 校验条目名并拆成路径段；目录条目末尾的 `/` 去掉。不安全时返回 None。
pub(crate) fn safe_parts(name: &str) -> Option<Vec<&str>> {
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    if trimmed.is_empty() || name.len() > MAX_NAME_BYTES || trimmed.starts_with('/') {
        return None;
    }
    let mut parts = Vec::new();
    for part in trimmed.split('/') {
        let bad_char = part
            .chars()
            .any(|c| c.is_control() || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'));
        if part.is_empty()
            || part == "."
            || part == ".."
            || bad_char
            || part.ends_with('.')
            || part.ends_with(' ')
            || is_reserved_windows_name(part)
        {
            return None;
        }
        parts.push(part);
    }
    Some(parts)
}

/// 条目数据在压缩包里的位置（跳过本地文件头）。
fn data_range(data: &[u8], entry: &Entry) -> Result<std::ops::Range<usize>, ArchiveError> {
    let corrupt = || ArchiveError::Corrupt(entry.name.clone());
    let at = usize::try_from(entry.local_offset).map_err(|_| corrupt())?;
    if u32_at(data, at) != Some(LFH_SIG) {
        return Err(corrupt());
    }
    let name_len = usize::from(u16_at(data, at + 26).ok_or_else(corrupt)?);
    let extra_len = usize::from(u16_at(data, at + 28).ok_or_else(corrupt)?);
    let start = at + 30 + name_len + extra_len;
    let end = start
        .checked_add(usize::try_from(entry.compressed).map_err(|_| corrupt())?)
        .filter(|&e| e <= data.len())
        .ok_or_else(corrupt)?;
    Ok(start..end)
}

/// 把 zip 数据解到 `dest`（必须已存在且为空的目录）。失败时 `dest` 里可能留有部分文件，由调用方删除。
pub(crate) fn extract_zip(data: &[u8], dest: &Path) -> Result<Extracted, ArchiveError> {
    if data.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(ArchiveError::TooLarge(format!(
            "压缩包超过 {} MiB",
            MAX_ARCHIVE_BYTES / 1024 / 1024
        )));
    }
    let entries = read_central_directory(data)?;
    // 先按中央目录检查名字、重名与大小，任何一条不合格都不写出任何文件
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    let mut plan: Vec<(&Entry, PathBuf)> = Vec::new();
    let mut skipped_links = 0;
    for entry in &entries {
        let parts =
            safe_parts(&entry.name).ok_or_else(|| ArchiveError::UnsafeName(entry.name.clone()))?;
        if entry.is_link {
            skipped_links += 1;
            continue;
        }
        if entry.flags & 1 != 0 {
            return Err(invalid("不支持加密的压缩包"));
        }
        if !entry.is_dir && entry.method != 0 && entry.method != 8 {
            return Err(invalid(&format!("不支持的压缩方式 {}", entry.method)));
        }
        if entry.size > MAX_FILE_BYTES {
            return Err(ArchiveError::TooLarge(format!(
                "{} 超过 {} MiB",
                entry.name,
                MAX_FILE_BYTES / 1024 / 1024
            )));
        }
        total = total.saturating_add(entry.size);
        if total > MAX_TOTAL_BYTES {
            return Err(ArchiveError::TooLarge(format!(
                "解压后超过 {} MiB",
                MAX_TOTAL_BYTES / 1024 / 1024
            )));
        }
        let key = parts.join("/").to_lowercase();
        if !entry.is_dir && !seen.insert(key) {
            return Err(ArchiveError::UnsafeName(entry.name.clone()));
        }
        let mut path = dest.to_path_buf();
        path.extend(&parts);
        plan.push((entry, path));
    }
    let mut files = 0;
    let mut written = 0u64;
    for (entry, path) in plan {
        if entry.is_dir {
            std::fs::create_dir_all(&path)?;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let range = data_range(data, entry)?;
        let raw = &data[range];
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        let mut crc = flate2::Crc::new();
        let mut copied = 0u64;
        let mut buf = [0u8; 64 * 1024];
        let mut reader: Box<dyn Read> = if entry.method == 8 {
            Box::new(flate2::read::DeflateDecoder::new(raw))
        } else {
            Box::new(raw)
        };
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|_| ArchiveError::Corrupt(entry.name.clone()))?;
            if n == 0 {
                break;
            }
            copied += n as u64;
            // 实际字节超过中央目录写的大小（伪造的大小）：按损坏处理，不继续解
            if copied > entry.size {
                return Err(ArchiveError::Corrupt(entry.name.clone()));
            }
            crc.update(&buf[..n]);
            out.write_all(&buf[..n])?;
        }
        written += copied;
        if copied != entry.size || crc.sum() != entry.crc || written > MAX_TOTAL_BYTES {
            return Err(ArchiveError::Corrupt(entry.name.clone()));
        }
        files += 1;
    }
    Ok(Extracted {
        files,
        skipped_links,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 测试用的 zip 写入器：每条给出名字、内容、是否 deflate 与 Unix 文件类型（0 表示不写 Unix 属性）。
    pub(crate) struct ZipBuilder {
        data: Vec<u8>,
        central: Vec<u8>,
        count: u16,
    }

    impl ZipBuilder {
        pub(crate) fn new() -> Self {
            Self {
                data: Vec::new(),
                central: Vec::new(),
                count: 0,
            }
        }

        pub(crate) fn file(self, name: &str, body: impl AsRef<[u8]>) -> Self {
            self.entry(name, body.as_ref(), true, 0o100_644, None)
        }

        pub(crate) fn entry(
            mut self,
            name: &str,
            body: &[u8],
            deflate: bool,
            mode: u32,
            claimed: Option<(u32, u32)>,
        ) -> Self {
            let mut crc = flate2::Crc::new();
            crc.update(body);
            let stored = if deflate {
                let mut e =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                e.write_all(body).unwrap();
                e.finish().unwrap()
            } else {
                body.to_vec()
            };
            let (crc, size) = claimed.unwrap_or((crc.sum(), body.len() as u32));
            let method: u16 = if deflate { 8 } else { 0 };
            let offset = self.data.len() as u32;
            let header = |sig: u32, central: bool| {
                let mut h = Vec::new();
                h.extend(sig.to_le_bytes());
                if central {
                    h.extend((3u16 << 8 | 20).to_le_bytes());
                }
                h.extend(20u16.to_le_bytes());
                h.extend(0x0800u16.to_le_bytes());
                h.extend(method.to_le_bytes());
                h.extend([0u8; 4]);
                h.extend(crc.to_le_bytes());
                h.extend((stored.len() as u32).to_le_bytes());
                h.extend(size.to_le_bytes());
                h.extend((name.len() as u16).to_le_bytes());
                h.extend(0u16.to_le_bytes());
                if central {
                    h.extend([0u8; 6]);
                    h.extend((mode << 16).to_le_bytes());
                    h.extend(offset.to_le_bytes());
                }
                h.extend(name.as_bytes());
                h
            };
            self.data.extend(header(LFH_SIG, false));
            self.data.extend(&stored);
            self.central.extend(header(CDH_SIG, true));
            self.count += 1;
            self
        }

        pub(crate) fn finish(self) -> Vec<u8> {
            let mut out = self.data;
            let offset = out.len() as u32;
            out.extend(&self.central);
            out.extend(EOCD_SIG.to_le_bytes());
            out.extend([0u8; 4]);
            out.extend(self.count.to_le_bytes());
            out.extend(self.count.to_le_bytes());
            out.extend((self.central.len() as u32).to_le_bytes());
            out.extend(offset.to_le_bytes());
            out.extend(0u16.to_le_bytes());
            out
        }
    }

    pub(crate) fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "primus-zip-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn extracts_files_and_directories() {
        let zip = ZipBuilder::new()
            .entry("repo-main/", b"", false, 0o040_755, None)
            .file("repo-main/SKILL.md", b"---\nname: x\n---\n")
            .entry(
                "repo-main/scripts/run.ps1",
                b"Write-Host hi",
                false,
                0,
                None,
            )
            .finish();
        let dir = temp("ok");
        let out = extract_zip(&zip, &dir).unwrap();
        assert_eq!(out.files, 2);
        assert_eq!(
            std::fs::read_to_string(dir.join("repo-main/SKILL.md")).unwrap(),
            "---\nname: x\n---\n"
        );
        assert_eq!(
            std::fs::read(dir.join("repo-main/scripts/run.ps1")).unwrap(),
            b"Write-Host hi"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_unsafe_names_before_writing_anything() {
        for name in [
            "../evil",
            "a/../../evil",
            "/abs",
            "C:/x",
            "a\\..\\b",
            "a/./b",
            "a//b",
            "file.txt:stream",
            "CON",
            "dir/nul.txt",
            "COM1.md",
            "COM¹.md",
            "lpt³",
            "trailing.",
            "space ",
            "ctrl\u{1}",
            "q?.md",
        ] {
            let zip = ZipBuilder::new()
                .file("ok.md", b"x")
                .file(name, b"x")
                .finish();
            let dir = temp("unsafe");
            assert!(
                matches!(extract_zip(&zip, &dir), Err(ArchiveError::UnsafeName(_))),
                "{name}"
            );
            assert!(
                !dir.join("ok.md").exists(),
                "{name}：不合格时一个文件也不写"
            );
            std::fs::remove_dir_all(dir).unwrap();
        }
        assert!(safe_parts("a/b.md").is_some());
        assert!(safe_parts("COMPANY/readme.md").is_some());
    }

    #[test]
    fn rejects_case_insensitive_duplicates() {
        let zip = ZipBuilder::new()
            .file("a/SKILL.md", b"1")
            .file("A/skill.md", b"2")
            .finish();
        let dir = temp("dup");
        assert!(matches!(
            extract_zip(&zip, &dir),
            Err(ArchiveError::UnsafeName(_))
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn skips_symlinks() {
        let zip = ZipBuilder::new()
            .file("s/SKILL.md", b"x")
            .entry("s/link", b"/etc/passwd", false, 0o120_777, None)
            .finish();
        let dir = temp("link");
        let out = extract_zip(&zip, &dir).unwrap();
        assert_eq!(
            out,
            Extracted {
                files: 1,
                skipped_links: 1
            }
        );
        assert!(std::fs::symlink_metadata(dir.join("s/link")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn skips_symlinks_from_os_x_archives() {
        let mut zip = ZipBuilder::new()
            .file("s/SKILL.md", b"x")
            .entry("s/link", b"/etc/passwd", false, 0o120_777, None)
            .finish();
        // 把每条中央目录记录的创建系统改成 19（OS X）
        let sig = CDH_SIG.to_le_bytes();
        let at: Vec<_> = zip
            .windows(4)
            .enumerate()
            .filter(|(_, w)| *w == sig)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(at.len(), 2);
        for i in at {
            zip[i + 5] = 19;
        }
        let dir = temp("link19");
        let out = extract_zip(&zip, &dir).unwrap();
        assert_eq!(
            out,
            Extracted {
                files: 1,
                skipped_links: 1
            }
        );
        assert!(std::fs::symlink_metadata(dir.join("s/link")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn archive_comment_containing_the_end_signature() {
        let mut zip = ZipBuilder::new().file("s/SKILL.md", b"x").finish();
        let mut comment = EOCD_SIG.to_le_bytes().to_vec();
        comment.extend([b'x'; 18]);
        let len = zip.len();
        zip[len - 2..].copy_from_slice(&(comment.len() as u16).to_le_bytes());
        zip.extend(&comment);
        let dir = temp("comment");
        assert_eq!(extract_zip(&zip, &dir).unwrap().files, 1);
        assert!(dir.join("s/SKILL.md").is_file());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn checks_sizes_and_crc() {
        let dir = temp("crc");
        // CRC 不符
        let zip = ZipBuilder::new()
            .entry("a.md", b"hello", true, 0, Some((1, 5)))
            .finish();
        assert!(matches!(
            extract_zip(&zip, &dir),
            Err(ArchiveError::Corrupt(_))
        ));
        std::fs::remove_dir_all(&dir).unwrap();
        // 中央目录写的大小比实际小（解压炸弹伪装）：读到超出即停
        let dir = temp("bomb");
        let body = vec![b'a'; 100_000];
        let mut crc = flate2::Crc::new();
        crc.update(&body);
        let zip = ZipBuilder::new()
            .entry("a.md", &body, true, 0, Some((crc.sum(), 10)))
            .finish();
        assert!(matches!(
            extract_zip(&zip, &dir),
            Err(ArchiveError::Corrupt(_))
        ));
        std::fs::remove_dir_all(&dir).unwrap();
        // 中央目录声明超过单文件上限：解压前拒绝
        let dir = temp("big");
        let zip = ZipBuilder::new()
            .entry(
                "a.md",
                b"x",
                false,
                0,
                Some((0, (MAX_FILE_BYTES + 1) as u32)),
            )
            .finish();
        assert!(matches!(
            extract_zip(&zip, &dir),
            Err(ArchiveError::TooLarge(_))
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_garbage_and_encryption() {
        let dir = temp("bad");
        assert!(matches!(
            extract_zip(b"not a zip at all, definitely not", &dir),
            Err(ArchiveError::Invalid(_))
        ));
        let mut zip = ZipBuilder::new().file("a.md", b"x").finish();
        // 把中央目录里的通用标志改成加密
        let cd = zip
            .windows(4)
            .position(|w| w == CDH_SIG.to_le_bytes())
            .unwrap();
        zip[cd + 8] |= 1;
        assert!(matches!(
            extract_zip(&zip, &dir),
            Err(ArchiveError::Invalid(_))
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
