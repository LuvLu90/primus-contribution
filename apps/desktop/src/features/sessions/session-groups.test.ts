import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@/lib/platform/types";
import {
  buildRows,
  groupSessions,
  isProjectWorkspace,
  stableProjectOrder,
  workspaceKey,
  workspaceName,
} from "./session-groups";

const s = (n: number, workspace: string): SessionSummary => ({
  path: `/s/${n}.jsonl`,
  id: `id-${n}`,
  name: null,
  title: `会话 ${n}`,
  workspace,
  createdAt: 0,
  updatedAt: 100 - n,
  messageCount: 1,
  archived: false,
});

const DEFAULT = "C:\\Primus\\data\\users\\S-1-5-21\\chat";
const KEY = workspaceKey(DEFAULT);

describe("会话分组", () => {
  it("默认工作目录与空串不算项目；项目名取最后一段，比较不分大小写与斜杠", () => {
    expect(isProjectWorkspace(DEFAULT, KEY)).toBe(false);
    expect(isProjectWorkspace("c:/primus/data/users/s-1-5-21/chat/", KEY)).toBe(false);
    expect(isProjectWorkspace("", KEY)).toBe(false);
    expect(isProjectWorkspace("D:\\code\\tihu", KEY)).toBe(true);
    // 只与当前用户的默认目录比较：别处同样以 users/<名>/chat 结尾的文件夹仍是项目
    expect(isProjectWorkspace("D:\\projects\\users\\alice\\chat", KEY)).toBe(true);
    expect(workspaceName("D:\\code\\tihu\\")).toBe("tihu");
    expect(workspaceKey("D:\\Code\\Tihu\\")).toBe(workspaceKey("d:/code/tihu"));
  });

  it("项目在前（最近活动的默认展开），无项目的会话在“最近”", () => {
    const rows = buildRows([s(1, "D:\\a"), s(2, DEFAULT), s(3, "D:\\b"), s(4, "d:/a/")], {
      projectsOpen: true,
      toggled: {},
      defaultKey: KEY,
    });
    expect(rows.map((r) => (r.kind === "session" ? r.session.id : r.key))).toEqual([
      "h:projects",
      "p:d:/a",
      "id-1",
      "id-4",
      "p:d:/b",
      "h:recent",
      "id-2",
    ]);
  });

  it("用户折叠与当前标签所在项目；“项目”分组收起时只留标题", () => {
    const list = [s(1, "D:\\a"), s(2, "D:\\b")];
    const rows = buildRows(list, {
      projectsOpen: true,
      toggled: { "d:/a": false },
      activeKey: "d:/b",
    });
    expect(rows.filter((r) => r.kind === "session").map((r) => r.key)).toEqual(["/s/2.jsonl"]);
    expect(
      buildRows(list, { projectsOpen: false, toggled: {}, defaultKey: KEY }).map((r) => r.key),
    ).toEqual(["h:projects"]);
  });

  it("没有项目时不显示分组标题", () => {
    expect(
      buildRows([s(1, DEFAULT)], { projectsOpen: true, toggled: {}, defaultKey: KEY }),
    ).toEqual([{ kind: "session", key: "/s/1.jsonl", session: s(1, DEFAULT), nested: false }]);
  });

  it("置顶的项目排在最前（按置顶顺序）并默认展开第一个；显示名称可改", () => {
    const list = [s(1, "D:\\a"), s(2, "D:\\b"), s(3, "D:\\c")];
    const rows = buildRows(list, {
      projectsOpen: true,
      toggled: {},
      pinned: ["d:/c", "d:/gone", "d:/b"],
      names: { "d:/b": "后端" },
    });
    const projects = rows.filter((r) => r.kind === "project");
    expect(projects.map((r) => [r.name, r.pinned, r.expanded])).toEqual([
      ["c", true, true],
      ["后端", true, false],
      ["a", false, false],
    ]);
  });

  it("移除的项目在没有新活动前不显示，之后有更新的会话时重新出现", () => {
    const list = [s(1, "D:\\a"), s(2, "D:\\b")];
    // s(2) 的 updatedAt 为 98
    const hidden = buildRows(list, { projectsOpen: true, toggled: {}, removed: { "d:/b": 98 } });
    expect(hidden.filter((r) => r.kind === "project").map((r) => r.key)).toEqual(["p:d:/a"]);
    expect(hidden.some((r) => r.key === "/s/2.jsonl")).toBe(false);
    const back = buildRows(list, { projectsOpen: true, toggled: {}, removed: { "d:/b": 97 } });
    expect(back.filter((r) => r.kind === "project").map((r) => r.key)).toEqual([
      "p:d:/a",
      "p:d:/b",
    ]);
    // 只剩被移除的项目、也没有“最近”时没有分组标题
    expect(
      buildRows([s(2, "D:\\b")], { projectsOpen: true, toggled: {}, removed: { "d:/b": 98 } }),
    ).toEqual([]);
  });

  it("项目顺序稳定：已显示的项目保持原位，新项目插到最前", () => {
    expect(stableProjectOrder(undefined, ["b", "a"])).toEqual(["b", "a"]);
    expect(stableProjectOrder(["a", "b"], ["b", "a"])).toEqual(["a", "b"]);
    expect(stableProjectOrder(["a", "b"], ["c", "b"])).toEqual(["c", "b"]);
  });

  it("加载更旧的历史分页时，首次出现的旧项目接在已有项目之后", () => {
    const opts = { projectsOpen: true, toggled: {}, defaultKey: KEY };
    const first = groupSessions([s(1, "D:\\a"), s(2, "D:\\b")], opts);
    expect(first.order).toEqual(["d:/a", "d:/b"]);
    // loadMore 追加更旧的一页，其中首次出现项目 c
    const page = [s(1, "D:\\a"), s(2, "D:\\b"), s(3, "D:\\c"), s(4, "D:\\a")];
    const paged = groupSessions(page, { ...opts, order: first.order });
    expect(paged.order).toEqual(["d:/a", "d:/b", "d:/c"]);
    expect(paged.rows.filter((r) => r.kind === "project").map((r) => r.key)).toEqual([
      "p:d:/a",
      "p:d:/b",
      "p:d:/c",
    ]);
    // 之后新建的项目 d 比已有项目都新，仍排在最前
    const fresh = { ...s(5, "D:\\d"), updatedAt: 300 };
    const next = groupSessions([fresh, ...page], { ...opts, order: paged.order });
    expect(next.order).toEqual(["d:/d", "d:/a", "d:/b", "d:/c"]);
  });

  it("按最后活动时间区分新近项目与历史分页补入的旧项目", () => {
    const latest = new Map([
      ["a", 90],
      ["b", 80],
      ["new", 95],
      ["old", 10],
    ]);
    expect(stableProjectOrder(["a", "b"], ["new", "a", "b", "old"], latest)).toEqual([
      "new",
      "a",
      "b",
      "old",
    ]);
  });

  it("运行中的会话更新时间后，项目不随最后活动时间上下跳动", () => {
    const opts = { projectsOpen: true, toggled: {}, defaultKey: KEY };
    const first = groupSessions([s(1, "D:\\a"), s(2, "D:\\b")], opts);
    expect(first.order).toEqual(["d:/a", "d:/b"]);
    // b 的会话刚有新活动，排到了 a 前面
    const bumped = { ...s(2, "D:\\b"), updatedAt: 200 };
    const next = groupSessions([bumped, s(1, "D:\\a")], { ...opts, order: first.order });
    expect(next.order).toEqual(["d:/a", "d:/b"]);
    expect(next.rows.filter((r) => r.kind === "project").map((r) => r.key)).toEqual([
      "p:d:/a",
      "p:d:/b",
    ]);
    // 不传上次顺序时仍按最后活动时间排
    expect(groupSessions([bumped, s(1, "D:\\a")], opts).order).toEqual(["d:/b", "d:/a"]);
  });
});
