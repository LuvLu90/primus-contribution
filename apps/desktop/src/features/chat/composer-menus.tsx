"use client";

// 输入框周边的弹出菜单：“+”添加菜单、选择工作区、权限模式；以及附件（本地路径引用）小标签。
import { appendFileTags } from "@primus/protocol";
import { DropdownMenu as Menu } from "radix-ui";
import { Fragment, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { FileIcon, Icon, type IconName } from "@/components/icons";
import {
  GlassPopover,
  GlassPopoverContent,
  GlassPopoverTrigger,
} from "@/components/ui/glass-popover";
import { Tooltip } from "@/components/ui/tooltip";
import { canPickFiles, canUseWorkspaces, getPlatform } from "@/lib/platform";
import type { WorkspaceInfo } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import type { PermissionMode } from "@/stores/app-store";
import {
  type CapabilityKind,
  type ComposerCapability,
  capabilityKey,
} from "./composer-capabilities";
import { fileIconForName } from "./file-ref";
import { TrustDialog } from "./trust-dialog";

const t = strings.chat;

/** 菜单行：圆角高亮、图标 + 文字，高亮态用轻微的黑/白叠色（输入栏各菜单与模型列表共用） */
export const rowClass =
  "mx-1.5 flex cursor-default select-none items-center gap-2.5 rounded-[10px] px-2.5 py-[7px] text-sm text-fg outline-none " +
  "data-[highlighted]:bg-black/[0.06] data-[disabled]:opacity-45 dark:data-[highlighted]:bg-white/[0.1]";

export const separatorClass = "mx-3 my-1 h-px bg-black/[0.07] dark:bg-white/[0.09]";

/** 取路径最后一段作为显示名（兼容 \ 与 /） */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 操作失败的提示：说明哪一步失败，再附上原因 */
export function failure(what: string, e: unknown): string {
  const reason = e instanceof Error ? e.message : String(e);
  return reason ? `${what}：${reason}` : what;
}

/** 当前平台是否能弹系统文件对话框（首帧为 false） */
export function useCanPickFiles(): boolean {
  const [can, setCan] = useState(false);
  // 只在客户端判断运行环境，避免水合不一致
  useEffect(() => setCan(canPickFiles()), []);
  return can;
}

/** 当前平台是否能列出/打开工作区（首帧为 false） */
export function useCanUseWorkspaces(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => setCan(canUseWorkspaces()), []);
  return can;
}

/**
 * 选择工作区：顶部搜索、最近工作区列表（当前项打勾）、底部"打开文件夹…"调用系统对话框。
 * 需要信任确认的工作区（首次打开或 `.primus/` 已变化）先弹出确认，选择后才交给 `onPicked`。
 */
export function WorkspacePicker({
  current,
  onPicked,
  onError,
  children,
}: {
  current: WorkspaceInfo | null;
  onPicked: (ws: WorkspaceInfo) => void;
  /** 打开工作区或选择文件夹失败（此时菜单通常已关闭）；成功时传 null 清除提示 */
  onError?: (message: string | null) => void;
  children: ReactNode;
}) {
  const [items, setItems] = useState<WorkspaceInfo[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingTrust, setPendingTrust] = useState<WorkspaceInfo | null>(null);
  // 只处理最近一次打开请求的结果：较早的请求晚到时丢弃，不覆盖用户最后的选择
  const openSeq = useRef(0);
  // 卸载（如清除工作区）后作废仍在途的打开请求，晚到的结果不再回调 onPicked
  useEffect(
    () => () => {
      openSeq.current++;
    },
    [],
  );
  const canPick = useCanPickFiles();
  // 菜单内显示（菜单仍开着时），同时交给外层显示（选择后菜单已关闭）
  const fail = (message: string) => {
    setError(message);
    onError?.(message);
  };

  const onOpenChange = (open: boolean) => {
    if (!open) return;
    setQuery("");
    setError(null);
    getPlatform()
      .then((p) => p.workspaceList())
      .then(setItems)
      .catch((e) => setError(failure(t.workspaceListFailed, e)));
  };

  const open = (path: string) => {
    const seq = ++openSeq.current;
    return getPlatform()
      .then((p) => p.workspaceOpen(path))
      .then((ws) => {
        if (seq !== openSeq.current) return;
        setError(null);
        onError?.(null);
        if (ws.needsTrust) setPendingTrust(ws);
        else onPicked(ws);
      })
      .catch((e) => {
        if (seq === openSeq.current) fail(failure(t.workspaceOpenFailed, e));
      });
  };

  const browse = () =>
    getPlatform()
      .then((p) => p.dialogPickFolder())
      .then((path) => (path ? open(path) : undefined))
      .catch((e) => fail(failure(t.pickFolderFailed, e)));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((w) => `${w.name} ${w.path}`.toLowerCase().includes(q)) : items;
  }, [items, query]);

  return (
    <>
      <TrustDialog
        workspace={pendingTrust}
        onDecided={(ws) => {
          setPendingTrust(null);
          onPicked(ws);
        }}
        onCancel={() => setPendingTrust(null)}
      />
      <GlassPopover onOpenChange={onOpenChange}>
        <GlassPopoverTrigger asChild>{children}</GlassPopoverTrigger>
        <GlassPopoverContent
          side="top"
          sideOffset={10}
          tint={0.8}
          minWidth={264}
          className="max-w-80"
        >
          <div className="-mt-0.5 flex items-center gap-2 px-4 pb-2 pt-0.5">
            <Icon name="search" size="sm" className="text-muted" />
            <input
              // biome-ignore lint/a11y/noAutofocus: 打开菜单即可输入筛选
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // 不让菜单的首字母跳转吞掉输入；方向键交给菜单
              onKeyDown={(e) => {
                if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape")
                  e.stopPropagation();
              }}
              placeholder={t.searchWorkspaces}
              aria-label={t.searchWorkspaces}
              className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/70"
            />
          </div>
          <div className={separatorClass} />
          {error && (
            <p role="alert" className="px-4 pt-1.5 text-xs text-danger">
              {error}
            </p>
          )}
          <div className="scroll-thin max-h-60 overflow-y-auto py-0.5">
            {filtered.length === 0 ? (
              <p className="px-4 py-2 text-xs text-muted">
                {items.length === 0 ? t.noRecentWorkspaces : t.noMatchingWorkspaces}
              </p>
            ) : (
              filtered.map((ws) => (
                <Menu.Item
                  key={ws.path}
                  className={rowClass}
                  textValue={ws.name}
                  onSelect={() => void open(ws.path)}
                >
                  <Icon name="folder" size="sm" className="text-muted" />
                  <Tooltip content={ws.path} side="right">
                    <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                  </Tooltip>
                  {current?.path === ws.path && <Icon name="check" size="sm" />}
                </Menu.Item>
              ))
            )}
          </div>
          {canPick && (
            <>
              <div className={separatorClass} />
              <Menu.Item
                className={cn(rowClass, "text-muted data-[highlighted]:text-fg")}
                onSelect={() => void browse()}
              >
                <Icon name="plus" size="sm" />
                <span>{strings.layout.openFolder}</span>
              </Menu.Item>
            </>
          )}
        </GlassPopoverContent>
      </GlassPopover>
    </>
  );
}

/** 各权限模式的图标与强调色：完全访问用警示色，提醒风险 */
export const permissionMeta: Record<PermissionMode, { icon: IconName; tone: string }> = {
  ask: { icon: "ask", tone: "" },
  edit: { icon: "shield-check", tone: "text-success" },
  full: { icon: "shield-alert", tone: "text-warning" },
};

const MODES: PermissionMode[] = ["ask", "edit", "full"];

/** 权限模式：三档，每档一句说明；当前项右侧打勾，完全访问整行用警示色。选择后由会话同步给 primus-guard 执行 */
export function PermissionPicker({
  mode,
  onChange,
  children,
}: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  children: ReactNode;
}) {
  return (
    <GlassPopover>
      <GlassPopoverTrigger asChild>{children}</GlassPopoverTrigger>
      <GlassPopoverContent
        side="top"
        sideOffset={10}
        tint={0.8}
        minWidth={300}
        className="max-w-[340px]"
      >
        <Menu.RadioGroup value={mode} onValueChange={(v) => onChange(v as PermissionMode)}>
          {MODES.map((m) => {
            const { icon, tone } = permissionMeta[m];
            const p = t.permissions[m];
            return (
              <Menu.RadioItem
                key={m}
                value={m}
                textValue={p.label}
                className={cn(rowClass, "items-start gap-3 py-2", m === "full" && tone)}
              >
                <Icon name={icon} className={cn("mt-0.5", tone || "text-muted")} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium leading-snug">{p.label}</span>
                  <span
                    className={cn(
                      "text-xs leading-snug",
                      m === "full" ? "opacity-80" : "text-muted",
                    )}
                  >
                    {p.hint}
                  </span>
                </span>
                <Menu.ItemIndicator className="mt-0.5 shrink-0">
                  <Icon name="check" size="sm" />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            );
          })}
        </Menu.RadioGroup>
      </GlassPopoverContent>
    </GlassPopover>
  );
}

/** “+”菜单的一行：图标、名称、名称后的灰色说明；右侧可放快捷键或勾选标记 */
function AddRow({
  icon,
  label,
  hint,
  trailing,
  iconClassName,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  trailing?: ReactNode;
  iconClassName?: string;
}) {
  return (
    <>
      <Icon name={icon} size="sm" className={cn("shrink-0 text-muted", iconClassName)} />
      <span className="min-w-0 flex-1 truncate">
        {label}
        {hint && <span className="ml-2 text-muted">{hint}</span>}
      </span>
      {trailing}
    </>
  );
}

/** 技能 / MCP 超过这个数量时先折叠，只显示前 COLLAPSED_COUNT 个 */
export const COLLAPSE_THRESHOLD = 6;
export const COLLAPSED_COUNT = 5;

/** “+”菜单里的一个小节：技能或 MCP。每项前加“/”，勾选即挂到输入框上方；数量多时折叠 */
function CapabilitySection({
  kind,
  items,
  selected,
  onToggle,
}: {
  kind: CapabilityKind;
  /** null：还在读取 */
  items: ComposerCapability[] | null;
  selected: ReadonlySet<string>;
  onToggle: (c: ComposerCapability) => void;
}) {
  const labelId = useId();
  const [expanded, setExpanded] = useState(false);
  const list = items?.filter((c) => c.kind === kind) ?? null;
  const collapsible = list !== null && list.length > COLLAPSE_THRESHOLD;
  const shown = list && collapsible && !expanded ? list.slice(0, COLLAPSED_COUNT) : list;
  const title = kind === "skill" ? t.add.skills : t.add.mcp;
  return (
    <Menu.Group aria-labelledby={labelId}>
      <Menu.Label
        id={labelId}
        className="truncate px-4 pt-1.5 pb-1 text-2xs font-medium text-muted"
      >
        {title}
      </Menu.Label>
      {list === null ? (
        <p className="px-4 py-1.5 text-xs text-muted">{t.add.loading}</p>
      ) : (
        shown?.map((c) => (
          <Menu.CheckboxItem
            key={capabilityKey(c)}
            className={rowClass}
            textValue={`/${c.name}`}
            checked={selected.has(capabilityKey(c))}
            onCheckedChange={() => onToggle(c)}
            // 可连续勾选多项：选中后菜单不关闭
            onSelect={(e) => e.preventDefault()}
            title={c.description ?? undefined}
          >
            <AddRow
              icon={kind === "skill" ? "bulb" : "server"}
              label={`/${c.name}`}
              hint={c.scope === "project" ? t.add.scopeProject : t.add.scopeGlobal}
              trailing={
                <span aria-hidden className="flex w-3.5 shrink-0 justify-center">
                  <Menu.ItemIndicator>
                    <Icon name="check" size="sm" />
                  </Menu.ItemIndicator>
                </span>
              }
            />
          </Menu.CheckboxItem>
        ))
      )}
      {collapsible && (
        <Menu.Item
          className={cn(rowClass, "text-muted")}
          textValue={expanded ? t.add.showLess : t.add.showAll}
          onSelect={(e) => {
            e.preventDefault();
            setExpanded((v) => !v);
          }}
        >
          <AddRow
            icon="chevron-down"
            iconClassName={expanded ? "rotate-180" : undefined}
            label={expanded ? t.add.showLess : t.add.showAll.replace("{n}", String(list.length))}
          />
        </Menu.Item>
      )}
    </Menu.Group>
  );
}

/**
 * 输入框左下角的“+”菜单：与模型选择同款的玻璃弹层，向上展开。
 * “添加”小节：文件（系统对话框，只引用本地路径；薄壳不支持时不显示）、计划模式（勾选项，Shift+Tab 同样切换）。
 * 其下列出全局与当前项目的全部技能、MCP 服务器（每项前加“/”，多了折叠），勾选后以标签挂在输入框上方。
 * 打开与关闭时调用 `onOpenChange`（打开时重新读取技能与 MCP）
 */
export function AddMenu({
  canPickFiles,
  filesDisabled,
  onPickFiles,
  planOn,
  onPlanChange,
  imageOn,
  onImageChange,
  capabilities,
  selected,
  onToggleCapability,
  onOpenChange,
  children,
}: {
  canPickFiles: boolean;
  /** 发送中不能再加附件 */
  filesDisabled?: boolean;
  onPickFiles: () => void;
  planOn: boolean;
  onPlanChange: (on: boolean) => void;
  /** 图片生成模式：选中后输入框上方出现“图片生成”标签，这条消息直接出图 */
  imageOn: boolean;
  onImageChange: (on: boolean) => void;
  /** 可选的技能与 MCP；null 表示还在读取 */
  capabilities: ComposerCapability[] | null;
  /** 已选项的 capabilityKey */
  selected: ReadonlySet<string>;
  onToggleCapability: (c: ComposerCapability) => void;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <GlassPopover onOpenChange={onOpenChange}>
      <GlassPopoverTrigger asChild>{children}</GlassPopoverTrigger>
      <GlassPopoverContent
        side="top"
        sideOffset={10}
        tint={0.8}
        minWidth={280}
        className="max-w-[360px]"
      >
        <div className="scroll-none max-h-[min(60vh,480px)] overflow-y-auto">
          <Menu.Group aria-labelledby={labelId}>
            <Menu.Label
              id={labelId}
              className="truncate px-4 pt-0.5 pb-1 text-2xs font-medium text-muted"
            >
              {t.add.title}
            </Menu.Label>
            {canPickFiles && (
              <Menu.Item
                className={rowClass}
                textValue={t.add.files}
                disabled={filesDisabled}
                onSelect={onPickFiles}
              >
                <AddRow icon="attach" label={t.add.files} />
              </Menu.Item>
            )}
            <Menu.CheckboxItem
              className={rowClass}
              textValue={t.plan.toggle}
              checked={planOn}
              onCheckedChange={(v) => onPlanChange(v === true)}
            >
              <AddRow
                icon="bulb"
                label={t.plan.toggle}
                hint={planOn ? t.add.planOnHint : t.add.planHint}
                trailing={
                  <span aria-hidden className="flex w-3.5 shrink-0 justify-center">
                    <Menu.ItemIndicator>
                      <Icon name="check" size="sm" />
                    </Menu.ItemIndicator>
                  </span>
                }
              />
            </Menu.CheckboxItem>
            <Menu.CheckboxItem
              className={rowClass}
              textValue={t.add.image}
              checked={imageOn}
              onCheckedChange={(v) => onImageChange(v === true)}
            >
              <AddRow
                icon="image"
                label={t.add.image}
                hint={t.add.imageHint}
                trailing={
                  <span aria-hidden className="flex w-3.5 shrink-0 justify-center">
                    <Menu.ItemIndicator>
                      <Icon name="check" size="sm" />
                    </Menu.ItemIndicator>
                  </span>
                }
              />
            </Menu.CheckboxItem>
          </Menu.Group>
          {/* 全局与项目里都没有技能 / MCP 时整段不显示（读取中仍显示“正在读取…”） */}
          {(["skill", "mcp"] as const)
            .filter((k) => capabilities === null || capabilities.some((c) => c.kind === k))
            .map((k) => (
              <Fragment key={k}>
                <Menu.Separator className={separatorClass} />
                <CapabilitySection
                  kind={k}
                  items={capabilities}
                  selected={selected}
                  onToggle={onToggleCapability}
                />
              </Fragment>
            ))}
        </div>
      </GlassPopoverContent>
    </GlassPopover>
  );
}

/** 输入框上方的已选技能 / MCP 标签：“/名称”，可移除 */
export function CapabilityChips({
  items,
  onRemove,
  locked = false,
  image = false,
  onRemoveImage,
}: {
  items: ComposerCapability[];
  onRemove: (c: ComposerCapability) => void;
  /** 提交中不能移除 */
  locked?: boolean;
  /** 图片生成模式已开启：排在最前，可移除 */
  image?: boolean;
  onRemoveImage?: () => void;
}) {
  if (items.length === 0 && !image) return null;
  return (
    <ul aria-label={t.capabilities.label} className="flex flex-wrap gap-1.5 px-1 pb-1">
      {image && (
        <li className="flex h-7 items-center gap-1.5 rounded-[9px] bg-accent/10 pl-2 pr-1 text-xs text-accent ring-1 ring-accent/20">
          <Icon name="image" size="sm" className="shrink-0" />
          <span>{t.capabilities.image}</span>
          <button
            type="button"
            aria-label={t.capabilities.removeImage}
            disabled={locked}
            onClick={onRemoveImage}
            className="grid size-5 shrink-0 place-items-center rounded-md outline-none hover:bg-accent/15"
          >
            <Icon name="x" size="xs" />
          </button>
        </li>
      )}
      {items.map((c) => (
        <li
          key={capabilityKey(c)}
          className="flex h-7 max-w-56 items-center gap-1.5 rounded-[9px] bg-accent/10 pl-2 pr-1 text-xs text-accent ring-1 ring-accent/20"
        >
          <Icon name={c.kind === "skill" ? "bulb" : "server"} size="sm" className="shrink-0" />
          <span className="min-w-0 truncate">/{c.name}</span>
          <button
            type="button"
            aria-label={t.capabilities.remove.replace("{name}", `/${c.name}`)}
            disabled={locked}
            onClick={() => onRemove(c)}
            className="grid size-5 shrink-0 place-items-center rounded-md outline-none hover:bg-accent/15"
          >
            <Icon name="x" size="xs" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 附件小标签：只显示文件名，悬停看完整路径，可移除 */
export function AttachmentChips({
  paths,
  onRemove,
}: {
  paths: string[];
  onRemove: (path: string) => void;
}) {
  if (paths.length === 0) return null;
  return (
    <ul aria-label={t.attach} className="flex flex-wrap gap-1.5 px-1 pb-1">
      {paths.map((p) => (
        <Tooltip key={p} content={p}>
          <li className="group flex h-7 max-w-56 items-center gap-1.5 rounded-[9px] bg-tile pl-2 pr-1 text-xs ring-1 ring-tile-ring">
            <FileIcon name={fileIconForName(baseName(p))} size="sm" />
            <span className="min-w-0 truncate">{baseName(p)}</span>
            <button
              type="button"
              aria-label={`${t.removeAttachment} ${baseName(p)}`}
              onClick={() => onRemove(p)}
              className="grid size-5 shrink-0 place-items-center rounded-md text-muted outline-none hover:bg-hover hover:text-fg"
            >
              <Icon name="x" size="xs" />
            </button>
          </li>
        </Tooltip>
      ))}
    </ul>
  );
}

/**
 * 发送时把附件作为 Core 原生的 `<file name="路径"></file>` 引用附在正文之后（本地应用：不复制、不上传）。
 * 文本文件由第一方扩展 primus-attach 在 Core 的 input 事件里内联，其余由模型按路径用工具读取
 */
export function withAttachments(message: string, paths: string[]): string {
  return appendFileTags(
    message,
    paths.map((path) => ({ path })),
  );
}
