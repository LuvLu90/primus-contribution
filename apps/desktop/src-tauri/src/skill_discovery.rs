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
//! 同名技能谁先被加载，这里只列出不加载）；记下走过的真实路径，链接成环时不重复进入（Core 会一直走到报错）。

use std::collections::HashSet;
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
fn add_ignore_rules(rules: &mut IgnoreRules, dir: &Path, rel_dir: &str) {
    let prefix = if rel_dir.is_empty() {
        String::new()
    } else {
        format!("{rel_dir}/")
    };
    for name in IGNORE_FILE_NAMES {
        let Ok(content) = std::fs::read_to_string(dir.join(name)) else {
            continue;
        };
        // 与 Core 的 split(/\r?\n/) 一致：只去掉 \n 前的一个 \r
        for line in content.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(p) = prefix_ignore_pattern(line, &prefix) {
                rules.add(&p);
            }
        }
    }
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
pub(crate) fn collect(root: &Path, mode: Mode) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut rules = IgnoreRules::default();
    let mut visited = HashSet::new();
    walk(root, "", true, mode, &mut rules, &mut out, &mut visited);
    out
}

/// 把 `dir` 当作 Core 用户目录 `skills/` 下的一个子目录（安装后的位置）来找技能：与 Core 加载安装后的
/// `skills/<名称>/` 结果相同（相对路径与忽略规则都带上 `<名称>/` 前缀；`skills/` 自己的忽略文件不算）。
pub(crate) fn collect_as_installed(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut rules = IgnoreRules::default();
    let mut visited = HashSet::new();
    // 前缀的名字不影响结果：所有规则与路径都在它下面
    walk(
        dir,
        "_",
        false,
        Mode::Core,
        &mut rules,
        &mut out,
        &mut visited,
    );
    out
}

fn join_rel(rel_dir: &str, name: &str) -> String {
    if rel_dir.is_empty() {
        name.to_owned()
    } else {
        format!("{rel_dir}/{name}")
    }
}

fn walk(
    dir: &Path,
    rel_dir: &str,
    is_root: bool,
    mode: Mode,
    rules: &mut IgnoreRules,
    out: &mut Vec<PathBuf>,
    visited: &mut HashSet<PathBuf>,
) {
    if !dir.exists() {
        return;
    }
    if let Ok(real) = dir.canonicalize()
        && !visited.insert(real)
    {
        return;
    }
    add_ignore_rules(rules, dir, rel_dir);
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<(String, PathBuf)> = read
        .flatten()
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    // 名字完全是 SKILL.md、是文件（跟随链接）、没被忽略：这个目录是一个技能
    if let Some((name, path)) = entries.iter().find(|(n, _)| n == "SKILL.md")
        && std::fs::metadata(path).is_ok_and(|m| m.is_file())
        && !rules.ignores(&join_rel(rel_dir, name), false)
    {
        out.push(path.clone());
        return;
    }

    for (name, path) in &entries {
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        // 跟随链接；断开的跳过
        let Ok(meta) = std::fs::metadata(path) else {
            continue;
        };
        let rel = join_rel(rel_dir, name);
        let md_counts = match mode {
            Mode::Core => is_root,
            Mode::Agents => !is_root,
        };
        if meta.is_file() && name.ends_with(".md") && !rules.ignores(&rel, false) && md_counts {
            out.push(path.clone());
            continue;
        }
        if !meta.is_dir() || rules.ignores(&rel, true) {
            continue;
        }
        walk(path, &rel, false, mode, rules, out, visited);
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
}
