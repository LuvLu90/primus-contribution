//! Core 的技能发现规则（ADR 0017），逐条移植自 agent-core
//! `packages/coding-agent/src/core/package-manager.ts` 的 `collectSkillEntries` / `addIgnoreRules` /
//! `prefixIgnorePattern`（`core/skills.ts` 的 `loadSkillsFromDirInternal` 是同一套规则）：
//!
//! - 目录里有 `SKILL.md`（名字完全一致、是文件或指向文件的链接、没被忽略）时，它就是一个技能，不再往下找；
//! - 否则逐项看：跳过 `.` 开头的项与 `node_modules`；跟随链接，断开的跳过；`*.md` 文件只在
//!   `skills/` 根目录（[`Mode::Core`]）或 `.agents/skills` 的子目录里（[`Mode::Agents`]）各算一个技能；
//!   目录（没被忽略的）递归；
//! - 每进入一个目录，读它的 `.gitignore`、`.ignore`、`.fdignore`，每行按 Core 的写法加上相对根目录的前缀
//!   （`a/` 下的 `foo` 变成 `a/foo`，`/foo` 去掉开头的 `/`），追加进同一组规则，后面的规则优先。
//!
//! Core 用 npm 的 `ignore` 包（7.x，默认不区分大小写）判断是否忽略；这里实现它对这些路径的判断：
//! `!` 取反、末尾 `/` 只匹配目录、含 `/`（不算末尾的）的规则从根目录起匹配，否则匹配最后一段，`*`、`?`、
//! `[...]`（含 `!` / `^` 取反、范围、`[:alpha:]` 等）、`**/`、`/**/`、`/**`，`\` 转义，去掉没转义的行尾空格。
//! 与 `ignore` 包一样也检查上级目录（Core 不进入被忽略的目录，这一步只为与它逐条一致）。
//!
//! 与 Core 的差别只有两处，都不改变结果：同一目录的子项按名字排序（Core 用 `readdir` 的顺序，只影响
//! 同名技能谁先被加载，这里只列出不加载）；当前递归链上的目录经链接又回到链上某一级（成环）时不再进入（Core 会一直
//! 走到报错）。不在链上的重复路径照常进入，与 Core 一样：`a` 链接到 `pkg/other` 时两处都列出（同一个文件 Core 只加载
//! 一次，那是加载时按真实路径去重，见 [`crate::skills::list`]）。

use std::path::{Path, PathBuf};

/// Core 的两种发现方式（`SkillDiscoveryMode`：`pi` / `agents`）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Mode {
    /// `<Core 用户目录>/skills`：根目录下直接的 `*.md` 各是一个技能
    Core,
    /// `.agents/skills`：根目录下的 `*.md` 不算，子目录里（没有 `SKILL.md` 时）的 `*.md` 各是一个技能
    Agents,
}

/// Core 读的忽略文件。
const IGNORE_FILE_NAMES: [&str; 3] = [".gitignore", ".ignore", ".fdignore"];

/// 一个 `[...]` 里的成员。
#[derive(Debug, Clone)]
enum Member {
    Char(char),
    Range(char, char),
    /// POSIX 字符类（`[:alpha:]`）
    Posix(fn(char) -> bool),
}

/// 一段路径模式里的一个记号。
#[derive(Debug, Clone)]
enum Tok {
    Lit(char),
    /// `*`：一段内任意多个字符
    Star,
    /// `?`：一段内一个字符
    One,
    Class {
        negated: bool,
        members: Vec<Member>,
    },
}

/// 模式的一段（`/` 之间）。
#[derive(Debug, Clone)]
enum Seg {
    /// 整段是 `**`：任意多段（在末尾时至少一段）
    Globstar,
    Glob(Vec<Tok>),
}

/// 一条忽略规则。
#[derive(Debug, Clone)]
struct Rule {
    negated: bool,
    /// 末尾有 `/`：只匹配目录
    dir_only: bool,
    /// 含 `/`（不算末尾的）：从根目录起匹配整条路径；否则只匹配最后一段
    anchored: bool,
    segs: Vec<Seg>,
}

/// Core 一次发现过程里累积的忽略规则（Core 的 `ignore()` 实例）。
#[derive(Default, Debug)]
pub(crate) struct IgnoreRules {
    rules: Vec<Rule>,
}

impl IgnoreRules {
    /// 加入一行（已按 Core 的 `prefixIgnorePattern` 加好前缀）；`ignore` 包认为无效的行跳过。
    fn add(&mut self, pattern: &str) {
        if let Some(rule) = parse_rule(pattern) {
            self.rules.push(rule);
        }
    }

    /// 相对根目录的路径（`/` 分隔，不带末尾的 `/`）是否被忽略；`is_dir` 对应 Core 给目录加的末尾 `/`。
    /// 与 `ignore` 包一样先看上级目录：上级被忽略时它也被忽略（不能再被 `!` 规则放回来）。
    pub(crate) fn ignores(&self, rel: &str, is_dir: bool) -> bool {
        let lower = rel.to_lowercase();
        let path: Vec<&str> = lower.split('/').collect();
        (1..path.len()).any(|n| self.test(&path[..n], true)) || self.test(&path, is_dir)
    }

    /// 只看这一条路径本身（不看上级）：后面的规则优先。
    fn test(&self, path: &[&str], is_dir: bool) -> bool {
        let mut ignored = false;
        for rule in &self.rules {
            // 后面的规则优先：只有能改变结果的规则才需要匹配
            if rule.negated == ignored && rule.matches(path, is_dir) {
                ignored = !rule.negated;
            }
        }
        ignored
    }
}

/// Core 的 `prefixIgnorePattern`：空行与注释返回 None；`!` 留在最前，开头的 `/` 去掉后加前缀。
fn prefix_ignore_pattern(line: &str, prefix: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || (trimmed.starts_with('#') && !trimmed.starts_with("\\#")) {
        return None;
    }
    let (negated, pattern) = if let Some(rest) = line.strip_prefix('!') {
        (true, rest)
    } else if line.starts_with("\\!") {
        (false, &line[1..])
    } else {
        (false, line)
    };
    let pattern = pattern.strip_prefix('/').unwrap_or(pattern);
    let prefixed = format!("{prefix}{pattern}");
    Some(if negated {
        format!("!{prefixed}")
    } else {
        prefixed
    })
}

/// Core 的 `addIgnoreRules`：读 `dir` 下的忽略文件，每行加上 `dir` 相对根目录的前缀。
///
/// 不存在的（含断开的链接）与不是文件的（Core 的 `existsSync` 为假或读取时报错）跳过，与 Core 一致；其他读取错误
/// 返回给调用方：严格扫描时不能当作“没有这个文件”（丢掉一条 `!` 规则就会少找到技能）。读到的内容按 UTF-8 解码，
/// 无效字节换成替换字符（与 Core 的 `readFileSync(path, "utf-8")` 一致）。
fn add_ignore_rules(rules: &mut IgnoreRules, dir: &Path, rel_dir: &str) -> std::io::Result<()> {
    let prefix = if rel_dir.is_empty() {
        String::new()
    } else {
        format!("{rel_dir}/")
    };
    let mut first_error = None;
    for name in IGNORE_FILE_NAMES {
        let path = dir.join(name);
        let bytes = match fs_ops::metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Ok(m) if !m.is_file() => continue,
            Err(e) => Err(e),
            Ok(_) => fs_ops::read(&path),
        };
        let content = match bytes {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(e) => {
                // 其余忽略文件照常读入（宽松扫描用），错误留给调用方决定
                first_error.get_or_insert(e);
                continue;
            }
        };
        // 与 Core 的 split(/\r?\n/) 一致：只去掉 \n 前的一个 \r
        for line in content.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(p) = prefix_ignore_pattern(line, &prefix) {
                rules.add(&p);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// 发现过程用到的文件系统操作。测试可以在指定路径上注入读取错误（模拟瞬时的 I/O 故障）。
mod fs_ops {
    use std::io;
    use std::path::Path;

    /// 注入故障的操作种类。
    #[cfg_attr(not(test), allow(dead_code))]
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub(crate) enum Op {
        Metadata,
        SymlinkMetadata,
        Exists,
        Read,
    }

    #[cfg(test)]
    type Fault = (Op, std::path::PathBuf, usize, io::ErrorKind);

    #[cfg(test)]
    thread_local! {
        static FAULTS: std::cell::RefCell<Vec<Fault>> =
            const { std::cell::RefCell::new(Vec::new()) };
    }

    /// 测试用：本线程接下来对 `path` 的 `times` 次 `op` 操作返回错误（`ErrorKind::Other`）。
    #[cfg(test)]
    pub(crate) fn inject(op: Op, path: &Path, times: usize) {
        inject_kind(op, path, times, io::ErrorKind::Other);
    }

    /// 测试用：同 [`inject`]，但返回指定种类的错误（如 `NotFound`）。
    #[cfg(test)]
    pub(crate) fn inject_kind(op: Op, path: &Path, times: usize, kind: io::ErrorKind) {
        FAULTS.with(|f| f.borrow_mut().push((op, path.to_path_buf(), times, kind)));
    }

    #[cfg(test)]
    thread_local! {
        /// 测试用：`try_exists` 返回 `Ok(false)` 的路径与剩余次数（模拟扫描期间目录消失）。
        static ABSENT: std::cell::RefCell<Vec<(std::path::PathBuf, usize)>> =
            const { std::cell::RefCell::new(Vec::new()) };
    }

    /// 测试用：本线程接下来对 `path` 的 `times` 次 `try_exists` 返回 `Ok(false)`。
    #[cfg(test)]
    pub(crate) fn inject_absent(path: &Path, times: usize) {
        ABSENT.with(|a| a.borrow_mut().push((path.to_path_buf(), times)));
    }

    /// 测试用：清除本线程注入的故障。
    #[cfg(test)]
    pub(crate) fn clear() {
        FAULTS.with(|f| f.borrow_mut().clear());
        ABSENT.with(|a| a.borrow_mut().clear());
    }

    fn absent(path: &Path) -> bool {
        #[cfg(test)]
        {
            let hit = ABSENT.with(|a| {
                let mut a = a.borrow_mut();
                a.iter_mut()
                    .find(|(p, n)| p == path && *n > 0)
                    .map(|fault| fault.1 -= 1)
            });
            if hit.is_some() {
                return true;
            }
        }
        let _ = path;
        false
    }

    fn check(op: Op, path: &Path) -> io::Result<()> {
        #[cfg(test)]
        {
            let hit = FAULTS.with(|f| {
                let mut f = f.borrow_mut();
                f.iter_mut()
                    .find(|(o, p, n, _)| *o == op && p == path && *n > 0)
                    .map(|fault| {
                        fault.2 -= 1;
                        fault.3
                    })
            });
            if let Some(kind) = hit {
                return Err(io::Error::new(
                    kind,
                    format!("注入的故障：{op:?} {}", path.display()),
                ));
            }
        }
        let _ = (op, path);
        Ok(())
    }

    pub(super) fn metadata(path: &Path) -> io::Result<std::fs::Metadata> {
        check(Op::Metadata, path)?;
        std::fs::metadata(path)
    }

    pub(super) fn symlink_metadata(path: &Path) -> io::Result<std::fs::Metadata> {
        check(Op::SymlinkMetadata, path)?;
        std::fs::symlink_metadata(path)
    }

    pub(super) fn try_exists(path: &Path) -> io::Result<bool> {
        check(Op::Exists, path)?;
        if absent(path) {
            return Ok(false);
        }
        path.try_exists()
    }

    pub(super) fn read(path: &Path) -> io::Result<Vec<u8>> {
        check(Op::Read, path)?;
        std::fs::read(path)
    }
}

#[cfg(test)]
pub(crate) use fs_ops::{
    Op as FaultOp, clear as clear_faults, inject as inject_fault,
    inject_absent as inject_absent_dir, inject_kind as inject_fault_kind,
};

/// `metadata` 的错误是不是“断开的链接”（Core 跳过它们）：目标不存在（`NotFound`），且路径本身确认是链接
/// （Windows 上含目录联接）。普通文件 / 目录的 `metadata` 瞬时返回 `NotFound`（如两次读取之间被替换）不算，
/// 严格扫描照常报错。
fn is_broken_link(path: &Path, e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::NotFound
        && fs_ops::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// `ignore` 包对一行模式的解释。无效（只有空格、末尾单个 `\`）时为 None。
fn parse_rule(raw: &str) -> Option<Rule> {
    // `#` 开头是注释（Core 去掉开头的 `/` 后 `/#x` 也成了注释）；只有空格的行无效
    if raw.starts_with('#') || raw.chars().all(|c| c == ' ') {
        return None;
    }
    let (negated, mut p) = match raw.strip_prefix('!') {
        Some(rest) => (true, rest.to_owned()),
        None => (false, raw.to_owned()),
    };
    // `\!`、`\#` 开头表示字面的 `!`、`#`
    if p.starts_with("\\!") || p.starts_with("\\#") {
        p.remove(0);
    }
    // `ignore` 包按去掉行尾空格之前的写法判断有没有不在末尾的 `/`（`a/  ` 也算从根目录起匹配）
    let anchored = p.find('/').is_some_and(|i| i + 1 < p.len());
    let p = trim_trailing_spaces(&p);
    if p.is_empty() || ends_with_lone_backslash(&p) {
        return None;
    }
    // 方括号先于 `/` 读出（`[a/b]` 是一个字符类，不是两段），再按 `/` 分段
    let mut toks = tokenize(&p);
    if matches!(toks.first(), Some(PTok::Slash)) {
        toks.remove(0);
    }
    // 有 `/`（含末尾的）时，与 `/` 相邻的 `**` 跨段（`**/` 即任意一层目录）
    let multi = toks.iter().any(|t| matches!(t, PTok::Slash));
    let dir_only = matches!(toks.last(), Some(PTok::Slash));
    if dir_only {
        toks.pop();
    }
    let parts: Vec<&[PTok]> = toks.split(|t| matches!(t, PTok::Slash)).collect();
    let segs = parts
        .into_iter()
        .map(|part| {
            // 整段是 `**` 且模式里有 `/`：跨段；没有 `/` 的 `**` 与 `*` 一样
            if multi && part.len() == 2 && part.iter().all(|t| matches!(t, PTok::Star)) {
                Seg::Globstar
            } else {
                Seg::Glob(
                    part.iter()
                        .map(|t| match t {
                            PTok::Star => Tok::Star,
                            PTok::Tok(t) => t.clone(),
                            PTok::Slash => unreachable!(),
                        })
                        .collect(),
                )
            }
        })
        .collect();
    Some(Rule {
        negated,
        dir_only,
        anchored,
        segs,
    })
}

/// 整条模式的记号：比 [`Tok`] 多出分段的 `/`；`*` 单独记，用来认出 `**`。
#[derive(Debug, Clone)]
enum PTok {
    Slash,
    Star,
    Tok(Tok),
}

/// 读整条模式。`[` 没有闭合（或类名不认识）时与 git 一样整条模式不匹配任何路径：放一个空字符类，后面不再读。
fn tokenize(p: &str) -> Vec<PTok> {
    let chars: Vec<char> = p.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '\\' if i + 1 < chars.len() => {
                toks.push(if chars[i + 1] == '/' {
                    PTok::Slash
                } else {
                    PTok::Tok(Tok::Lit(chars[i + 1]))
                });
                i += 2;
            }
            '/' => {
                toks.push(PTok::Slash);
                i += 1;
            }
            '*' => {
                toks.push(PTok::Star);
                i += 1;
            }
            '?' => {
                toks.push(PTok::Tok(Tok::One));
                i += 1;
            }
            '[' => match parse_class(&chars, i) {
                Some((tok, end)) => {
                    toks.push(PTok::Tok(tok));
                    i = end + 1;
                }
                None => {
                    toks.push(PTok::Tok(Tok::Class {
                        negated: false,
                        members: Vec::new(),
                    }));
                    break;
                }
            },
            c => {
                toks.push(PTok::Tok(Tok::Lit(c)));
                i += 1;
            }
        }
    }
    toks
}

/// 去掉行尾没转义的空格；`\ ` 结尾时保留一个空格（`ignore` 包与 git 一样只处理空格，不处理制表符）。
fn trim_trailing_spaces(p: &str) -> String {
    let trimmed = p.trim_end_matches(' ');
    if trimmed.len() == p.len() {
        return p.to_owned();
    }
    let backslashes = trimmed.chars().rev().take_while(|&c| c == '\\').count();
    if backslashes % 2 == 1 {
        // 被转义的空格：保留（转义符在解析时去掉）
        format!("{trimmed} ")
    } else {
        trimmed.to_owned()
    }
}

/// 末尾是单个（没被转义的）`\`。
fn ends_with_lone_backslash(p: &str) -> bool {
    p.chars().rev().take_while(|&c| c == '\\').count() % 2 == 1
}

fn posix_class(name: &str) -> Option<fn(char) -> bool> {
    Some(match name {
        "alnum" => |c: char| c.is_ascii_alphanumeric(),
        "alpha" => |c: char| c.is_ascii_alphabetic(),
        "blank" => |c: char| c == ' ' || c == '\t',
        "cntrl" => |c: char| c.is_ascii_control(),
        "digit" => |c: char| c.is_ascii_digit(),
        "graph" => |c: char| c.is_ascii_graphic() && c != '/',
        "lower" => |c: char| c.is_ascii_lowercase(),
        "print" => |c: char| (c.is_ascii_graphic() || c == ' ') && c != '/',
        "punct" => |c: char| c.is_ascii_punctuation() && c != '/',
        "space" => |c: char| matches!(c, ' ' | '\t' | '\n' | '\r'),
        "upper" => |c: char| c.is_ascii_uppercase(),
        "xdigit" => |c: char| c.is_ascii_hexdigit(),
        _ => return None,
    })
}

/// 从 `chars[start] == '['` 读一个方括号表达式（git `wildmatch.c` 的规则：`[` 或 `[!` 后紧跟的 `]` 是成员）。
/// 返回记号与结尾 `]` 的位置；没有闭合或类名不认识时为 None（整条模式不匹配任何路径）。
fn parse_class(chars: &[char], start: usize) -> Option<(Tok, usize)> {
    let mut i = start + 1;
    let negated = matches!(chars.get(i), Some('!' | '^'));
    if negated {
        i += 1;
    }
    let mut members = Vec::new();
    let mut prev: Option<char> = None;
    let mut first = true;
    loop {
        let c = *chars.get(i)?;
        if c == ']' && !first {
            return Some((Tok::Class { negated, members }, i));
        }
        first = false;
        if c == '\\' {
            let e = *chars.get(i + 1)?;
            members.push(Member::Char(e));
            prev = Some(e);
            i += 2;
        } else if c == '-' && prev.is_some() && i + 1 < chars.len() && chars[i + 1] != ']' {
            let mut to = chars[i + 1];
            i += 2;
            if to == '\\' {
                to = *chars.get(i)?;
                i += 1;
            }
            let from = prev.take().unwrap_or(to);
            // 倒序的范围不匹配任何字符（起点已作为单个成员加入）
            if from <= to {
                members.push(Member::Range(from, to));
            }
        } else if c == '[' && chars.get(i + 1) == Some(&':') {
            let name_start = i + 2;
            let end = name_start + chars[name_start..].iter().position(|&x| x == ']')?;
            if end > name_start && chars[end - 1] == ':' {
                let name: String = chars[name_start..end - 1].iter().collect();
                // 不认识的类名：整条模式不匹配任何路径
                members.push(Member::Posix(posix_class(&name)?));
                prev = None;
                i = end + 1;
            } else {
                members.push(Member::Char('['));
                prev = Some('[');
                i += 1;
            }
        } else {
            members.push(Member::Char(c));
            prev = Some(c);
            i += 1;
        }
    }
}

fn class_has(members: &[Member], c: char) -> bool {
    // 不区分大小写：原字符与大小写变体任一命中即可
    let variants = [
        c,
        c.to_uppercase().next().unwrap_or(c),
        c.to_lowercase().next().unwrap_or(c),
    ];
    variants.iter().any(|&v| {
        members.iter().any(|m| match m {
            Member::Char(x) => *x == v,
            Member::Range(a, b) => *a <= v && v <= *b,
            Member::Posix(f) => f(v),
        })
    })
}

/// 一个记号是否匹配一个字符（`*` 以外）。
fn tok_matches(tok: &Tok, x: char) -> bool {
    match tok {
        // 路径已转成小写（不区分大小写）
        Tok::Lit(c) => c.to_lowercase().eq(std::iter::once(x)),
        Tok::One => true,
        Tok::Class { negated, members } => {
            !members.is_empty() && x != '/' && class_has(members, x) != *negated
        }
        Tok::Star => false,
    }
}

/// 一段通配（记号）匹配一段路径（路径已转成小写）。除 `*` 外每个记号恰好匹配一个字符，用回退到上一个 `*`
/// 的双指针做法，耗时与两者长度之积成正比（来源不可信的忽略文件不能借回溯卡住界面）。
fn glob_match(toks: &[Tok], s: &[char]) -> bool {
    let (mut t, mut i) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while i < s.len() {
        if t < toks.len() && matches!(toks[t], Tok::Star) {
            star = Some((t, i));
            t += 1;
        } else if t < toks.len() && tok_matches(&toks[t], s[i]) {
            t += 1;
            i += 1;
        } else if let Some((st, si)) = star {
            t = st + 1;
            i = si + 1;
            star = Some((st, si + 1));
        } else {
            return false;
        }
    }
    toks[t..].iter().all(|tok| matches!(tok, Tok::Star))
}

/// 模式的各段匹配路径的各段（整条）。末尾的 `**` 至少一段，其他位置的可以是零段。动态规划，不回溯。
fn segs_match(segs: &[Seg], path: &[&str]) -> bool {
    let path: Vec<Vec<char>> = path.iter().map(|p| p.chars().collect()).collect();
    let (n, m) = (segs.len(), path.len());
    // ok[i][j]：segs[i..] 能匹配 path[j..]
    let mut ok = vec![vec![false; m + 1]; n + 1];
    ok[n][m] = true;
    for i in (0..n).rev() {
        for j in (0..=m).rev() {
            ok[i][j] = match &segs[i] {
                Seg::Globstar if i + 1 == n => j < m,
                Seg::Globstar => ok[i + 1][j] || (j < m && ok[i][j + 1]),
                Seg::Glob(toks) => j < m && glob_match(toks, &path[j]) && ok[i + 1][j + 1],
            };
        }
    }
    ok[0][0]
}

impl Rule {
    fn matches(&self, path: &[&str], is_dir: bool) -> bool {
        if self.dir_only && !is_dir {
            return false;
        }
        if self.anchored {
            segs_match(&self.segs, path)
        } else {
            // 只有一段：匹配路径的最后一段
            path.last()
                .is_some_and(|last| segs_match(&self.segs, std::slice::from_ref(last)))
        }
    }
}

/// 按 Core 的规则找出 `root` 下的技能文件（`SKILL.md` 或单个 `*.md`），顺序与 Core 的遍历一致（同一目录按名字）。
/// 读不了的目录与目录项跳过（Core 也是这样）。
pub(crate) fn collect(root: &Path, mode: Mode) -> Vec<PathBuf> {
    let mut walker = Walker::new(mode, false);
    // 宽松模式不会返回错误
    let _ = walker.walk(root, "", true);
    walker.out
}

/// 与 [`collect`] 相同，但任何读取错误（目录是否存在、目录、目录项、元数据、忽略文件，断开的链接与不存在的忽略文件
/// 除外）都返回错误：结果不完整时调用方
/// 不能把“没找到”当作“没有”（删除时判断顶层目录里还有没有技能）。
pub(crate) fn collect_complete(root: &Path, mode: Mode) -> std::io::Result<Vec<PathBuf>> {
    let mut walker = Walker::new(mode, true);
    walker.walk(root, "", true)?;
    Ok(walker.out)
}

/// 把 `dir` 当作 Core 用户目录 `skills/` 下的一个子目录（安装后的位置）来找技能：与 Core 加载安装后的
/// `skills/<名称>/` 结果相同（相对路径与忽略规则都带上 `<名称>/` 前缀；`skills/` 自己的忽略文件不算）。
pub(crate) fn collect_as_installed(dir: &Path) -> Vec<PathBuf> {
    let mut walker = Walker::new(Mode::Core, false);
    // 前缀的名字不影响结果：所有规则与路径都在它下面
    let _ = walker.walk(dir, "_", false);
    walker.out
}

fn join_rel(rel_dir: &str, name: &str) -> String {
    if rel_dir.is_empty() {
        name.to_owned()
    } else {
        format!("{rel_dir}/{name}")
    }
}

struct Walker {
    mode: Mode,
    /// 读取错误是否返回（否则跳过）
    strict: bool,
    rules: IgnoreRules,
    out: Vec<PathBuf>,
    /// 当前递归链上各级目录的真实路径（检测链接成环）
    chain: Vec<PathBuf>,
}

impl Walker {
    fn new(mode: Mode, strict: bool) -> Self {
        Self {
            mode,
            strict,
            rules: IgnoreRules::default(),
            out: Vec::new(),
            chain: Vec::new(),
        }
    }

    /// 宽松模式把错误当作跳过。
    fn fail(&self, e: std::io::Error) -> std::io::Result<()> {
        if self.strict { Err(e) } else { Ok(()) }
    }

    fn walk(&mut self, dir: &Path, rel_dir: &str, is_root: bool) -> std::io::Result<()> {
        // 元数据读取出错不等于不存在：严格扫描时返回错误。根目录不存在就是没有技能；子目录是刚从上一级读出来的，
        // 这时说不存在说明它在扫描期间消失了（可能马上又回来），严格扫描当作不完整
        match fs_ops::try_exists(dir) {
            Ok(true) => {}
            Ok(false) if is_root => return Ok(()),
            Ok(false) => {
                return self.fail(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("扫描期间目录消失：{}", dir.display()),
                ));
            }
            Err(e) => return self.fail(e),
        }
        let real = match dir.canonicalize() {
            Ok(r) => Some(r),
            Err(e) => {
                self.fail(e)?;
                None
            }
        };
        if let Some(real) = &real {
            if self.chain.contains(real) {
                return Ok(());
            }
            self.chain.push(real.clone());
        }
        let result = self.walk_dir(dir, rel_dir, is_root);
        if real.is_some() {
            self.chain.pop();
        }
        result
    }

    fn walk_dir(&mut self, dir: &Path, rel_dir: &str, is_root: bool) -> std::io::Result<()> {
        if let Err(e) = add_ignore_rules(&mut self.rules, dir, rel_dir) {
            self.fail(e)?;
        }
        let read = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(e) => return self.fail(e),
        };
        let mut entries: Vec<(String, PathBuf)> = Vec::new();
        for entry in read {
            match entry {
                Ok(e) => entries.push((e.file_name().to_string_lossy().into_owned(), e.path())),
                Err(e) => self.fail(e)?,
            }
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        // 名字完全是 SKILL.md、是文件（跟随链接）、没被忽略：这个目录是一个技能。读不到它的元数据时（断开的链接除外）
        // 严格扫描返回错误：不能断定它不是技能而接着往下找
        if let Some((name, path)) = entries.iter().find(|(n, _)| n == "SKILL.md") {
            let is_file = match fs_ops::metadata(path) {
                Ok(m) => m.is_file(),
                Err(e) => {
                    if !is_broken_link(path, &e) {
                        self.fail(e)?;
                    }
                    false
                }
            };
            if is_file && !self.rules.ignores(&join_rel(rel_dir, name), false) {
                self.out.push(path.clone());
                return Ok(());
            }
        }

        for (name, path) in &entries {
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            // 跟随链接；断开的跳过
            let meta = match fs_ops::metadata(path) {
                Ok(m) => m,
                Err(e) => {
                    if !is_broken_link(path, &e) {
                        self.fail(e)?;
                    }
                    continue;
                }
            };
            let rel = join_rel(rel_dir, name);
            let md_counts = match self.mode {
                Mode::Core => is_root,
                Mode::Agents => !is_root,
            };
            if meta.is_file()
                && name.ends_with(".md")
                && !self.rules.ignores(&rel, false)
                && md_counts
            {
                self.out.push(path.clone());
                continue;
            }
            if !meta.is_dir() || self.rules.ignores(&rel, true) {
                continue;
            }
            self.walk(path, &rel, false)?;
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::skill_archive::tests::temp;

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    pub(crate) fn rules(lines: &[&str]) -> IgnoreRules {
        let mut r = IgnoreRules::default();
        for l in lines {
            if let Some(p) = prefix_ignore_pattern(l, "") {
                r.add(&p);
            }
        }
        r
    }

    /// 与 npm `ignore@7.0.8` 逐例核对过的结果：（规则，路径，是否目录，是否忽略）
    #[test]
    fn matches_like_the_ignore_package() {
        let cases: &[(&[&str], &str, bool, bool)] = &[
            (&["foo"], "foo", false, true),
            (&["foo"], "a/foo", false, true),
            (&["foo"], "a/foo", true, true),
            (&["foo"], "foobar", false, false),
            (&["foo/"], "a/foo", false, false),
            (&["foo/"], "a/foo", true, true),
            (&["a/foo"], "a/foo", false, true),
            (&["a/foo"], "b/a/foo", false, false),
            (&["*.md"], "x/SKILL.md", false, true),
            (&["*.MD"], "x/skill.md", false, true),
            (&["SKILL.md"], "x/skill.MD", false, true),
            (&["a/*"], "a/b", true, true),
            (&["a/*"], "a/b/c", false, true),
            (&["a/**"], "a/b/c", false, true),
            (&["a/**"], "a", true, false),
            (&["a/**/c"], "a/c", true, true),
            (&["a/**/c"], "a/x/y/c", true, true),
            (&["**/c"], "x/y/c", true, true),
            (&["**/x/c"], "x/c", false, true),
            (&["a/**/"], "a/b", true, true),
            (&["a/**/"], "a/b", false, false),
            (&["d?"], "x/d1", false, true),
            (&["d?"], "x/d12", false, false),
            (&["[ab]x"], "bx", false, true),
            (&["[!ab]x"], "bx", false, false),
            (&["[!ab]x"], "cx", false, true),
            (&["[a-c]x"], "Bx", false, true),
            (&["[[:digit:]]x"], "7x", false, true),
            (&["[abc"], "[abc", false, false),
            (&["foo", "!foo"], "foo", false, false),
            (&["*", "!keep"], "keep", true, false),
            (&["*", "!keep"], "other", true, true),
            (&["\\#x"], "#x", false, true),
            (&["\\!x"], "!x", false, false),
            (&["x  "], "x", false, true),
            (&["x\\ "], "x ", false, true),
            (&["x\\"], "x", false, false),
            (&["\\*"], "*", false, true),
            (&["\\*"], "a", false, false),
            (&["a*b"], "a/x/b", false, false),
            (&["a**b"], "axyb", false, true),
            (&["dist/"], "dist", true, true),
        ];
        for (lines, path, is_dir, expected) in cases {
            assert_eq!(
                rules(lines).ignores(path, *is_dir),
                *expected,
                "{lines:?} {path} dir={is_dir}"
            );
        }
    }

    #[test]
    fn core_prefix_rules() {
        assert_eq!(prefix_ignore_pattern("# c", "a/"), None);
        assert_eq!(prefix_ignore_pattern("   ", "a/"), None);
        assert_eq!(
            prefix_ignore_pattern("/foo", "a/").as_deref(),
            Some("a/foo")
        );
        assert_eq!(
            prefix_ignore_pattern("!foo", "a/").as_deref(),
            Some("!a/foo")
        );
        assert_eq!(prefix_ignore_pattern("\\!foo", "").as_deref(), Some("!foo"));
        assert_eq!(
            prefix_ignore_pattern("\\#foo", "").as_deref(),
            Some("\\#foo")
        );
        // Core 去掉开头的 /：根目录的 /foo 在任何一层都匹配（与 git 不同，照 Core）
        let mut r = IgnoreRules::default();
        r.add(&prefix_ignore_pattern("/foo", "").unwrap());
        assert!(r.ignores("x/foo", true));
        // 子目录里的 foo 加前缀后只匹配那一层
        let mut r = IgnoreRules::default();
        r.add(&prefix_ignore_pattern("foo", "a/").unwrap());
        assert!(r.ignores("a/foo", true));
        assert!(!r.ignores("a/b/foo", true));
    }

    #[test]
    fn discovers_like_core() {
        let root = temp("discover");
        let s = "---\ndescription: d\n---\n";
        write(&root.join("README.md"), "readme");
        write(&root.join("one/SKILL.md"), s);
        write(&root.join("one/inner/SKILL.md"), s);
        write(&root.join("group/two/SKILL.md"), s);
        write(&root.join("group/notes.md"), "x");
        write(&root.join(".hidden/SKILL.md"), s);
        write(&root.join("node_modules/x/SKILL.md"), s);
        write(&root.join("dist/copy/SKILL.md"), s);
        write(&root.join("ignored-md/SKILL.md"), s);
        write(&root.join("ignored-md/sub/SKILL.md"), s);
        write(&root.join("lower/skill.md"), s);
        write(&root.join(".gitignore"), "dist/\n");
        write(&root.join("ignored-md/.ignore"), "SKILL.md\n");
        let rel = |v: Vec<PathBuf>| -> Vec<String> {
            v.iter()
                .map(|p| {
                    p.strip_prefix(&root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/")
                })
                .collect()
        };
        assert_eq!(
            rel(collect(&root, Mode::Core)),
            [
                "README.md",
                "group/two/SKILL.md",
                "ignored-md/sub/SKILL.md",
                "one/SKILL.md"
            ]
        );
        // 当作 skills/<名称>/ 时根目录的 *.md 不算；lower/skill.md 在子目录里也不算
        assert_eq!(
            rel(collect_as_installed(&root)),
            [
                "group/two/SKILL.md",
                "ignored-md/sub/SKILL.md",
                "one/SKILL.md"
            ]
        );
        assert_eq!(
            rel(collect(&root, Mode::Agents)),
            [
                "group/notes.md",
                "group/two/SKILL.md",
                "ignored-md/sub/SKILL.md",
                "lower/skill.md",
                "one/SKILL.md"
            ]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// 测试结束（含失败）时清掉本线程注入的故障。
    pub(crate) struct Faults;
    impl Drop for Faults {
        fn drop(&mut self) {
            clear_faults();
        }
    }

    fn rel_to(root: &Path, files: &[PathBuf]) -> Vec<String> {
        files
            .iter()
            .map(|p| {
                p.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
    }

    #[test]
    fn strict_scan_reports_ignore_file_read_errors() {
        let root = temp("ignore-read");
        // 根目录忽略所有 *.md，两个技能各靠自己目录里的 `!SKILL.md` 放回来
        write(&root.join(".gitignore"), "*.md\n");
        write(&root.join("pkg/inner/SKILL.md"), "x");
        write(&root.join("pkg/inner/.ignore"), "!SKILL.md\n");
        write(&root.join("pkg/other/SKILL.md"), "x");
        write(&root.join("pkg/other/.ignore"), "!SKILL.md\n");
        // 不存在的、是目录的忽略文件与 Core 一样跳过，不算错误
        std::fs::create_dir_all(root.join("pkg/inner/.fdignore")).unwrap();
        assert_eq!(
            rel_to(&root, &collect_complete(&root, Mode::Core).unwrap()),
            ["pkg/inner/SKILL.md", "pkg/other/SKILL.md"]
        );
        let _faults = Faults;
        inject_fault(FaultOp::Read, &root.join("pkg/other/.ignore"), usize::MAX);
        // 取反规则读不到：结果不完整，严格扫描返回错误
        assert!(collect_complete(&root, Mode::Core).is_err());
        // 宽松扫描与 Core 一样跳过读不了的忽略文件（other 因此被根目录的规则忽略）
        assert_eq!(
            rel_to(&root, &collect(&root, Mode::Core)),
            ["pkg/inner/SKILL.md"]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn strict_scan_reports_transient_metadata_errors() {
        let root = temp("meta-fault");
        write(&root.join("pkg/inner/SKILL.md"), "x");
        write(&root.join("pkg/other/SKILL.md"), "x");
        let skill = root.join("pkg/other/SKILL.md");
        let _faults = Faults;
        // 第一次读 SKILL.md 的元数据失败、第二次成功：宽松扫描会把它当作普通文件跳过，漏掉这个技能
        inject_fault(FaultOp::Metadata, &skill, 1);
        assert_eq!(
            rel_to(&root, &collect(&root, Mode::Core)),
            ["pkg/inner/SKILL.md"]
        );
        // 严格扫描返回错误
        inject_fault(FaultOp::Metadata, &skill, 1);
        assert!(collect_complete(&root, Mode::Core).is_err());
        // 读不到目录是否存在：不能当作不存在
        inject_fault(FaultOp::Exists, &root.join("pkg/other"), 1);
        assert!(collect_complete(&root, Mode::Core).is_err());
        inject_fault(FaultOp::Exists, &root, 1);
        assert!(collect_complete(&root, Mode::Core).is_err());
        // 故障用完后扫描完整；真正不存在的根目录不是错误
        assert_eq!(collect_complete(&root, Mode::Core).unwrap().len(), 2);
        assert!(
            collect_complete(&root.join("missing"), Mode::Core)
                .unwrap()
                .is_empty()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn strict_scan_reports_transient_not_found_on_regular_entries() {
        let root = temp("meta-notfound");
        write(&root.join("pkg/inner/SKILL.md"), "x");
        write(&root.join("pkg/other/SKILL.md"), "x");
        write(&root.join("solo/x/SKILL.md"), "x");
        let skill = root.join("pkg/other/SKILL.md");
        let _faults = Faults;
        // 普通文件的元数据瞬时返回 NotFound：它不是链接，不能当断链跳过
        inject_fault_kind(FaultOp::Metadata, &skill, 1, std::io::ErrorKind::NotFound);
        assert!(collect_complete(&root, Mode::Core).is_err());
        // 普通目录同样
        inject_fault_kind(
            FaultOp::Metadata,
            &root.join("solo"),
            1,
            std::io::ErrorKind::NotFound,
        );
        assert!(collect_complete(&root, Mode::Core).is_err());
        // 确认是不是链接时也读不到（NotFound）：不能断定是断链
        inject_fault_kind(FaultOp::Metadata, &skill, 1, std::io::ErrorKind::NotFound);
        inject_fault_kind(
            FaultOp::SymlinkMetadata,
            &skill,
            1,
            std::io::ErrorKind::NotFound,
        );
        assert!(collect_complete(&root, Mode::Core).is_err());
        assert_eq!(collect_complete(&root, Mode::Core).unwrap().len(), 3);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn strict_scan_reports_directories_that_vanish_during_the_scan() {
        let root = temp("vanish");
        write(&root.join("pkg/inner/SKILL.md"), "x");
        write(&root.join("pkg/other/SKILL.md"), "x");
        let other = root.join("pkg/other");
        let _faults = Faults;
        // 读出目录项、元数据也读到了，进入时 try_exists 却说不存在：严格扫描不完整
        inject_absent_dir(&other, 1);
        assert!(collect_complete(&root, Mode::Core).is_err());
        // 宽松扫描照旧跳过
        inject_absent_dir(&other, 1);
        assert_eq!(
            rel_to(&root, &collect(&root, Mode::Core)),
            ["pkg/inner/SKILL.md"]
        );
        // 根目录不存在仍是“没有技能”，不是错误
        inject_absent_dir(&root, 1);
        assert!(collect_complete(&root, Mode::Core).unwrap().is_empty());
        assert_eq!(collect_complete(&root, Mode::Core).unwrap().len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn strict_scan_skips_real_broken_links() {
        let root = temp("broken-link");
        write(&root.join("pkg/inner/SKILL.md"), "x");
        // 指向已删除目录的链接：Core 跳过，严格扫描也跳过，不算错误
        let gone = root.join("gone");
        std::fs::create_dir_all(&gone).unwrap();
        if !link_dir(&gone, &root.join("pkg/dangling")) {
            return;
        }
        std::fs::remove_dir(&gone).unwrap();
        assert_eq!(
            rel_to(&root, &collect_complete(&root, Mode::Core).unwrap()),
            ["pkg/inner/SKILL.md"]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// 建一个指向目录的链接。Unix 用符号链接；Windows 先试符号链接（要开发者模式或管理员），不行再建目录联接
    /// （`mklink /J`，不需要特权）。都建不了时打印原因并返回 false，调用方跳过这个测试。
    pub(crate) fn link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).unwrap();
            true
        }
        #[cfg(windows)]
        {
            // 链接目标里的 `/` 在 Windows 上不一定能解析：统一成 `\`
            let norm = |p: &Path| PathBuf::from(p.to_string_lossy().replace('/', "\\"));
            let (target, link) = (norm(target), norm(link));
            let symlink = match std::os::windows::fs::symlink_dir(&target, &link) {
                Ok(()) => return true,
                Err(e) => e,
            };
            let junction = std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(&link)
                .arg(&target)
                .output();
            match junction {
                Ok(o) if o.status.success() => true,
                Ok(o) => {
                    eprintln!(
                        "跳过：建不了目录链接（符号链接：{symlink}；目录联接：{}{}）",
                        String::from_utf8_lossy(&o.stdout).trim(),
                        String::from_utf8_lossy(&o.stderr).trim()
                    );
                    false
                }
                Err(e) => {
                    eprintln!("跳过：建不了目录链接（符号链接：{symlink}；目录联接：{e}）");
                    false
                }
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (target, link);
            false
        }
    }

    #[test]
    fn links_follow_like_core_and_only_cycles_stop() {
        let root = temp("links");
        let skills = root.join("skills");
        write(&skills.join("pkg/inner/SKILL.md"), "x");
        write(&skills.join("pkg/other/SKILL.md"), "x");
        write(&skills.join("loop/y/SKILL.md"), "x");
        // 回到链上一级的链接：成环，不再进入
        if !link_dir(&skills.join("pkg/other"), &skills.join("a"))
            || !link_dir(&skills.join("loop"), &skills.join("loop/back"))
        {
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        // 与 Core 的 collectSkillEntries 一样：链接与它指向的目录两处都列出
        assert_eq!(
            rel_to(&skills, &collect(&skills, Mode::Core)),
            [
                "a/SKILL.md",
                "loop/y/SKILL.md",
                "pkg/inner/SKILL.md",
                "pkg/other/SKILL.md"
            ]
        );
        assert_eq!(collect_complete(&skills, Mode::Core).unwrap().len(), 4);
        std::fs::remove_dir_all(root).unwrap();
    }
}
