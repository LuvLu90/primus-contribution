//! 各模型暂停到什么时候（Unix 秒），存成一个小 JSON 文件，重启后仍然有效。
//!
//! - 免费额度用完：每月重置的模型停到下个月 1 日 0 点（北京时间）；一次性额度停 30 天
//!   （额度本该不再恢复，30 天后试一次，防止控制台又发了新额度）。
//! - 模型用不了（未开通、无权限等）：停 24 小时。
//! - 临时错误、模型接不了这段录音：不记账。
//!
//! 百炼没有用 API Key 查询剩余额度的接口，只能按调用结果记账。

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::failure::Failure;
use crate::models::{Model, Quota};

const DAY: u64 = 86_400;
/// 北京时间相对 UTC 的偏移
const CST_OFFSET: u64 = 8 * 3600;

#[derive(Debug, Default)]
pub struct State {
    path: Option<PathBuf>,
    until: BTreeMap<String, u64>,
}

impl State {
    /// 从文件读取；文件不存在或损坏时从空状态开始。`path` 为 None 时只在内存里记账。
    pub fn load(path: Option<PathBuf>) -> Self {
        let until = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self { path, until }
    }

    /// 这款模型现在能不能用
    pub fn usable(&self, model: &Model, now: u64) -> bool {
        self.until.get(model.id).is_none_or(|&t| now >= t)
    }

    /// 按失败记账；返回是否有变化
    pub fn record(&mut self, model: &Model, failure: &Failure, now: u64) -> bool {
        let until = match failure {
            Failure::Quota(_) => match model.quota {
                Quota::Monthly => next_month_start_cst(now),
                Quota::OneOff => now + 30 * DAY,
            },
            Failure::Unusable(_) => now + DAY,
            Failure::Transient(_) | Failure::Unsuited(_) => return false,
        };
        self.until.insert(model.id.to_string(), until);
        self.save();
        true
    }

    /// 识别成功：清掉这款模型的记录
    pub fn clear(&mut self, model: &Model) {
        if self.until.remove(model.id).is_some() {
            self.save();
        }
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(bytes) = serde_json::to_vec(&self.until) {
            let tmp = path.with_extension("tmp");
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}

/// 下个月 1 日 0 点（北京时间）对应的 Unix 秒
pub fn next_month_start_cst(now: u64) -> u64 {
    let days = (now + CST_OFFSET) / DAY;
    let (y, m, _) = civil_from_days(days as i64);
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    (days_from_civil(ny, nm, 1) as u64) * DAY - CST_OFFSET
}

// Howard Hinnant 的公历日期算法（以 1970-01-01 为第 0 天）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MODELS;

    // 2026-11-14 19:41 北京时间 = 2026-11-14 11:41 UTC
    const NOW: u64 = 1_794_656_460;

    #[test]
    fn next_month_in_beijing_time() {
        // 2026-12-01 00:00 北京时间 = 2026-11-30 16:00 UTC
        assert_eq!(next_month_start_cst(NOW), 1_796_054_400);
        // 12 月跨年：2026-12-31 20:00 UTC 已是北京时间 2027-01-01，下一次是 2027-02-01
        let new_year_cst = 1_798_747_200;
        assert_eq!(next_month_start_cst(new_year_cst), 1_801_411_200);
    }

    #[test]
    fn quota_and_unusable_pause_transient_does_not() {
        let monthly = MODELS.iter().find(|m| m.quota == Quota::Monthly).unwrap();
        let one_off = &MODELS[0];
        let mut s = State::load(None);
        assert!(s.usable(monthly, NOW));
        assert!(!s.record(one_off, &Failure::Transient("net".into()), NOW));
        assert!(s.usable(one_off, NOW));
        s.record(monthly, &Failure::Quota("q".into()), NOW);
        assert!(!s.usable(monthly, NOW + 15 * DAY));
        assert!(s.usable(monthly, next_month_start_cst(NOW)));
        s.record(one_off, &Failure::Unusable("u".into()), NOW);
        assert!(!s.usable(one_off, NOW + DAY - 1));
        assert!(s.usable(one_off, NOW + DAY));
        s.clear(one_off);
        assert!(s.usable(one_off, NOW));
    }

    #[test]
    fn persists_to_file() {
        let dir = std::env::temp_dir().join(format!("primus-asr-{}", std::process::id()));
        let path = dir.join("asr.json");
        let mut s = State::load(Some(path.clone()));
        s.record(&MODELS[1], &Failure::Quota("q".into()), NOW);
        let again = State::load(Some(path));
        assert!(!again.usable(&MODELS[1], NOW));
        assert!(again.usable(&MODELS[2], NOW));
        let _ = std::fs::remove_dir_all(dir);
    }
}
