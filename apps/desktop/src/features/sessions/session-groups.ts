// 左栏会话分组：有项目（工作区文件夹）的会话归到该项目下（可折叠），未选工作区的会话放在“最近”。
// 纯函数，把分组展开成一维行列表，交给虚拟列表渲染。
import type { SessionSummary } from "@/lib/platform/types";

/**
 * 会话是否属于某个项目：工作区非空，且不是当前用户未选工作区时的默认目录。
 * `defaultKey` 是该默认目录完整路径的 {@link workspaceKey}（薄壳 `session_default_workspace`）。
 */
export function isProjectWorkspace(workspace: string, defaultKey: string | null): boolean {
  return workspace.trim() !== "" && workspaceKey(workspace) !== defaultKey;
}

/** 比较用的工作区键：统一斜杠、去掉末尾斜杠、不区分大小写（Windows 路径） */
export function workspaceKey(workspace: string): string {
  return workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 项目名：工作区路径的最后一段 */
export function workspaceName(workspace: string): string {
  const parts = workspace.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? workspace;
}

export type ListRow =
  | { kind: "header"; key: string; section: "projects" | "recent" }
  | {
      kind: "project";
      key: string;
      workspace: string;
      /** 显示名称：用户改过的名称，否则为文件夹名 */
      name: string;
      expanded: boolean;
      pinned: boolean;
    }
  | { kind: "session"; key: string; session: SessionSummary; nested: boolean };

export interface GroupOptions {
  /** “项目”分组是否展开 */
  projectsOpen: boolean;
  /** 用户手动展开 / 折叠过的项目（键为 workspaceKey） */
  toggled: Readonly<Record<string, boolean>>;
  /** 当前标签所在项目的键：默认展开 */
  activeKey?: string | null;
  /** 未选工作区时默认目录的键（workspaceKey）；这里的会话归入“最近” */
  defaultKey?: string | null;
  /** 置顶的项目键，按显示顺序 */
  pinned?: readonly string[];
  /** 用户改过的项目显示名称 */
  names?: Readonly<Record<string, string>>;
  /** 已移除的项目 → 移除时间；之后没有新活动的不显示 */
  removed?: Readonly<Record<string, number>>;
  /**
   * 上一次的项目顺序（含置顶的项目，置顶的仍排在最前）。给出时已显示的项目保持原位，只有新出现的项目按最新活动插到最前，
   * 避免会话运行时最后活动时间不断变化、几个项目轮流跳到顶上。
   */
  order?: readonly string[];
}

/**
 * 稳定的项目顺序：`previous` 里仍存在的项目保持原相对顺序，新出现的项目按 `byRecency` 的顺序排在最前。
 * 没有 `previous` 时就是 `byRecency`。
 */
export function stableProjectOrder(
  previous: readonly string[] | undefined,
  byRecency: readonly string[],
): string[] {
  if (!previous) return [...byRecency];
  const present = new Set(byRecency);
  const kept = previous.filter((k) => present.has(k));
  const keptSet = new Set(kept);
  return [...byRecency.filter((k) => !keptSet.has(k)), ...kept];
}

/**
 * 按项目分组并展开成行。会话已按最后活动时间倒序，项目顺序取其最新会话的位置，置顶的项目排在最前。
 * 项目默认折叠，排在第一的项目与当前标签所在项目默认展开；用户切换过的以用户为准。
 */
export function buildRows(sessions: readonly SessionSummary[], options: GroupOptions): ListRow[] {
  return groupSessions(sessions, options).rows;
}

/** 同 {@link buildRows}，另返回这次的稳定项目顺序（含置顶），供下次作为 `order` 传回以保持位置稳定。 */
export function groupSessions(
  sessions: readonly SessionSummary[],
  options: GroupOptions,
): { rows: ListRow[]; order: string[] } {
  const projects = new Map<string, { workspace: string; sessions: SessionSummary[] }>();
  const recent: SessionSummary[] = [];
  for (const s of sessions) {
    if (!isProjectWorkspace(s.workspace, options.defaultKey ?? null)) {
      recent.push(s);
      continue;
    }
    const key = workspaceKey(s.workspace);
    const group = projects.get(key);
    if (group) group.sessions.push(s);
    else projects.set(key, { workspace: s.workspace, sessions: [s] });
  }
  // 移除后没有新活动的项目不显示（每组第一条是最新会话）
  const removed = options.removed ?? {};
  for (const [key, group] of projects) {
    const at = removed[key];
    if (at !== undefined && (group.sessions[0]?.updatedAt ?? 0) <= at) projects.delete(key);
  }
  const pinned = (options.pinned ?? []).filter((k) => projects.has(k));
  // 稳定顺序包含置顶的项目，取消置顶后回到原来的位置
  const stable = stableProjectOrder(options.order, [...projects.keys()]);
  const order = [...pinned, ...stable.filter((k) => !pinned.includes(k))];

  const rows: ListRow[] = [];
  if (projects.size > 0) {
    rows.push({ kind: "header", key: "h:projects", section: "projects" });
    if (options.projectsOpen) {
      order.forEach((key, i) => {
        const group = projects.get(key);
        if (!group) return;
        const expanded = options.toggled[key] ?? (i === 0 || key === options.activeKey);
        rows.push({
          kind: "project",
          key: `p:${key}`,
          workspace: group.workspace,
          name: options.names?.[key] || workspaceName(group.workspace),
          expanded,
          pinned: pinned.includes(key),
        });
        if (expanded)
          for (const s of group.sessions)
            rows.push({ kind: "session", key: s.path, session: s, nested: true });
      });
    }
  }
  if (recent.length > 0) {
    if (projects.size > 0) rows.push({ kind: "header", key: "h:recent", section: "recent" });
    for (const s of recent) rows.push({ kind: "session", key: s.path, session: s, nested: false });
  }
  return { rows, order: stable };
}
