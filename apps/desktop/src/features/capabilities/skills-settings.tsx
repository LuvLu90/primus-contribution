"use client";

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import {
  GlassDialog,
  GlassDialogClose,
  GlassDialogContent,
  GlassDialogDescription,
  GlassDialogTitle,
} from "@/components/ui/glass-dialog";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import {
  getPlatform,
  PlatformError,
  SKILL_EXISTS,
  type SkillInfo,
  type SkillSource,
  type SkillStage,
} from "@/lib/platform";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { Badge, errorText } from "../settings/account-models";
import { checkSkill, suggestDirName, validDirName } from "./skill-frontmatter";
import {
  buttonClass,
  cardClass,
  fill,
  iconButtonClass,
  inputClass,
  primaryButtonClass,
} from "./ui";

// 能力中心·技能（ADR 0017）：安装（GitHub 链接 / zip / 本地文件夹 → 暂存，按 Core 的规则列出其中的全部技能 →
// 整个来源装进 `skills/<目录名>`，同名时确认替换）、列出 Core 用户目录 `skills/` 与 `~/.agents/skills` 中的技能、
// 启停（写 Core 设置）与删除（只限用户目录）。frontmatter 的解析与校验与 Core 一致：缺 description 的技能 Core
// 不加载，标出来；名称问题只提示。

const t = strings.settings.capabilities;
const ts = t.skills;
const td = ts.dialog;

export function SkillsSettings() {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ title: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stage, setStage] = useState<SkillStage | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SkillInfo | null>(null);
  const [github, setGithub] = useState("");
  const githubId = useId();
  const seq = useRef(0);

  const reload = async () => {
    const mine = ++seq.current;
    try {
      const list = await (await getPlatform()).skillsList();
      if (mine !== seq.current) return;
      setSkills(list);
      setLoadError(null);
    } catch (e) {
      if (mine === seq.current) setLoadError(errorText(e, ts.loadFailed));
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时读取一次
  useEffect(() => {
    void reload();
    return () => {
      seq.current++;
    };
  }, []);

  const run = async (id: string, title: string, action: () => Promise<void>) => {
    setBusy(id);
    setActionError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setActionError({ title, message: errorText(e, title) });
    } finally {
      setBusy(null);
    }
  };

  const stageFrom = (source: SkillSource) =>
    run("stage", ts.stageFailed, async () => {
      setStage(await (await getPlatform()).skillStage(source));
    });

  const onGithub = (e: FormEvent) => {
    e.preventDefault();
    if (github.trim()) void stageFrom({ kind: "github", url: github.trim() });
  };

  const pickZip = () =>
    run("stage", ts.stageFailed, async () => {
      const platform = await getPlatform();
      const [path] = await platform.dialogPickFiles();
      if (!path) return;
      if (!/\.zip$/i.test(path)) throw new Error(ts.notZip);
      setStage(await platform.skillStage({ kind: "zip", path }));
    });

  const pickFolder = () =>
    run("stage", ts.stageFailed, async () => {
      const platform = await getPlatform();
      const path = await platform.dialogPickFolder();
      if (path) setStage(await platform.skillStage({ kind: "folder", path }));
    });

  const toggle = (s: SkillInfo, enabled: boolean) =>
    run(s.file, ts.toggleFailed, async () => {
      await (await getPlatform()).skillSetEnabled(s.file, enabled);
      await reload();
    });

  const confirmDelete = () => {
    const s = pendingDelete;
    setPendingDelete(null);
    if (s)
      void run(s.file, ts.deleteFailed, async () => {
        await (await getPlatform()).skillDelete(s.file);
        await reload();
      });
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="px-1 text-xs font-medium text-muted">{ts.installTitle}</h3>
        <div className={cn(cardClass, "flex flex-col gap-3 px-4 py-3")}>
          <p className="text-xs text-muted">{ts.installHint}</p>
          <form onSubmit={onGithub} className="flex items-center gap-2">
            <label htmlFor={githubId} className="sr-only">
              {ts.githubLabel}
            </label>
            <input
              id={githubId}
              value={github}
              onChange={(e) => setGithub(e.target.value)}
              placeholder={ts.githubPlaceholder}
              spellCheck={false}
              className={inputClass}
            />
            <button
              type="submit"
              disabled={busy !== null || !github.trim()}
              className={buttonClass}
            >
              {busy === "stage" ? ts.staging : ts.githubRead}
            </button>
          </form>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={pickZip}
              disabled={busy !== null}
              className={buttonClass}
            >
              <Icon name="attach" size="sm" />
              {ts.pickZip}
            </button>
            <button
              type="button"
              onClick={pickFolder}
              disabled={busy !== null}
              className={buttonClass}
            >
              <Icon name="folder-open" size="sm" />
              {ts.pickFolder}
            </button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="px-1 text-xs font-medium text-muted">{ts.installedTitle}</h3>
        {notice && (
          <p role="status" className="px-1 text-sm text-muted">
            {notice}
          </p>
        )}
        {actionError && (
          <div role="alert" className="rounded-2xl px-4 py-3 text-sm ring-1 ring-danger/40">
            <p className="font-medium text-danger">{actionError.title}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-muted">{actionError.message}</p>
          </div>
        )}
        {loadError && (
          <div role="alert" className="rounded-2xl px-4 py-3 text-sm ring-1 ring-danger/40">
            <p className="font-medium text-danger">{loadError}</p>
          </div>
        )}
        {skills === null && !loadError ? (
          <p className="text-sm text-muted">{ts.loading}</p>
        ) : (
          <div className={cardClass}>
            {(skills ?? []).length === 0 ? (
              <p className="px-4 py-3 text-xs text-muted">{ts.empty}</p>
            ) : (
              <ul aria-label={ts.installedTitle} className="divide-y divide-border">
                {(skills ?? []).map((s) => (
                  <SkillRow
                    key={s.file}
                    skill={s}
                    disabled={busy !== null}
                    onToggle={(enabled) => void toggle(s, enabled)}
                    onDelete={() => setPendingDelete(s)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="px-1 text-xs text-muted">{t.newSessionHint}</p>
      </section>

      {stage && (
        <InstallDialog
          stage={stage}
          installed={skills ?? []}
          onClose={(installed) => {
            setStage(null);
            if (installed) {
              setNotice(fill(td.installed, installed));
              setGithub("");
            }
            void reload();
          }}
        />
      )}

      <GlassDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <GlassDialogContent>
          <GlassDialogTitle>
            {pendingDelete ? fill(ts.deleteTitle, { name: skillName(pendingDelete) }) : null}
          </GlassDialogTitle>
          <GlassDialogDescription>
            {pendingDelete?.link
              ? ts.deleteLinkDescription
              : fill(ts.deleteDescription, { dir: pendingDelete?.dir ?? "" })}
            {pendingDelete?.package
              ? ` ${fill(ts.deletePackageNote, { name: pendingDelete.package })}`
              : null}
          </GlassDialogDescription>
          <div className="mt-5 flex justify-end gap-2 text-sm">
            <GlassDialogClose asChild>
              <button type="button" className="rounded-full bg-hover px-4 py-1.5">
                {t.cancel}
              </button>
            </GlassDialogClose>
            <button
              type="button"
              onClick={confirmDelete}
              className="rounded-full bg-hover px-4 py-1.5 font-medium text-danger ring-1 ring-danger/40"
            >
              {t.deleteConfirm}
            </button>
          </div>
        </GlassDialogContent>
      </GlassDialog>
    </div>
  );
}

function skillName(s: SkillInfo): string {
  return s.content === null ? s.dirName : checkSkill(s.content, s.dirName).name;
}

function SkillRow({
  skill,
  disabled,
  onToggle,
  onDelete,
}: {
  skill: SkillInfo;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const check = skill.content === null ? null : checkSkill(skill.content, skill.dirName);
  const name = check?.name ?? skill.dirName;
  const problems = check ? [...check.errors, ...check.warnings] : [];
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate font-medium">{name}</span>
          {skill.scope === "agents" ? (
            <Tooltip content={ts.scopeAgentsHint}>
              <span>
                <Badge>{ts.scopeAgents}</Badge>
              </span>
            </Tooltip>
          ) : (
            <Badge>{ts.scopeUser}</Badge>
          )}
          {skill.package && (
            <Tooltip content={fill(ts.packageHint, { name: skill.package })}>
              <span>
                <Badge>{fill(ts.package, { name: skill.package })}</Badge>
              </span>
            </Tooltip>
          )}
          {skill.link && <Badge>{ts.link}</Badge>}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted">
          {check?.description?.trim() || ts.noDescription}
        </p>
        {problems.map((p) => (
          <p key={p} className="mt-0.5 text-xs text-danger">
            {p}
          </p>
        ))}
      </div>
      <Switch
        ariaLabel={fill(ts.enable, { name })}
        checked={skill.enabled}
        disabled={disabled}
        onCheckedChange={onToggle}
      />
      {skill.deletable && (
        <Tooltip content={t.delete}>
          <button
            type="button"
            aria-label={fill(ts.deleteLabel, { name })}
            disabled={disabled}
            onClick={onDelete}
            className={cn(iconButtonClass, "hover:text-danger")}
          >
            <Icon name="trash" />
          </button>
        </Tooltip>
      )}
    </li>
  );
}

/** 暂存后的确认与安装：列出来源中的全部技能（Core 是否加载、告警），确认目录名，同名时再确认替换。
 * 关闭时放弃暂存（安装成功后薄壳已删除暂存） */
function InstallDialog({
  stage,
  installed,
  onClose,
}: {
  stage: SkillStage;
  /** 已安装的技能：提示同名（Core 只加载其中一个） */
  installed: SkillInfo[];
  onClose: (installed: { name: string; n: number } | null) => void;
}) {
  const candidates = stage.candidates.map((c) => ({
    ...c,
    check: checkSkill(c.content, c.dirName),
  }));
  const loadable = candidates.filter((c) => c.check.errors.length === 0);
  const rootSkill = candidates.length === 1 && candidates[0]?.path === "";
  const [dirName, setDirName] = useState(
    () =>
      suggestDirName(rootSkill ? (candidates[0]?.check.name ?? "") : stage.label) ||
      suggestDirName(stage.label),
  );
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState<string | null>(null);
  const dirValid = validDirName(dirName);
  // 同名提示：不算会被这次安装替换掉的同名文件夹里的技能
  const replacedDir = (s: SkillInfo) =>
    s.scope === "user" && (s.package ?? s.dirName).toLowerCase() === dirName.toLowerCase();
  const installedNames = new Map(
    installed
      .filter((s) => s.content !== null && !replacedDir(s))
      .map((s) => [checkSkill(s.content ?? "", s.dirName).name, s] as const),
  );

  const close = (done: { name: string; n: number } | null) => {
    if (done === null)
      void getPlatform()
        .then((p) => p.skillDiscard(stage.stageId))
        .catch(() => {});
    onClose(done);
  };

  const install = async (force: boolean) => {
    if (!dirValid || loadable.length === 0) return;
    setInstalling(true);
    setError(null);
    try {
      await (await getPlatform()).skillInstall(stage.stageId, dirName, force);
      onClose({ name: dirName, n: loadable.length });
    } catch (e) {
      if (e instanceof PlatformError && e.code === SKILL_EXISTS) setOverwrite(dirName);
      else setError(errorText(e, td.installFailed));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      <GlassDialog open onOpenChange={(open) => !open && !installing && close(null)}>
        <GlassDialogContent>
          <GlassDialogTitle>{td.title}</GlassDialogTitle>
          <GlassDialogDescription>
            {td.description} {fill(td.found, { n: stage.candidates.length })}
            {fill(td.willLoad, { n: loadable.length })}
          </GlassDialogDescription>
          {(stage.truncated || stage.skippedLinks > 0) && (
            <p className="mt-2 text-xs text-muted">
              {stage.truncated && td.truncated}{" "}
              {stage.skippedLinks > 0 && fill(td.skippedLinks, { n: stage.skippedLinks })}
            </p>
          )}
          <ul
            aria-label={td.title}
            className="scroll-thin mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto"
          >
            {candidates.map((c) => {
              const blocked = c.check.errors.length > 0;
              const same = installedNames.get(c.check.name);
              return (
                <li key={c.path} className="rounded-xl px-3 py-2 ring-1 ring-border">
                  <span className="block truncate text-sm font-medium">{c.check.name}</span>
                  <span className="block truncate text-xs text-muted">{c.path || td.root}</span>
                  {c.check.description && (
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted">
                      {c.check.description}
                    </span>
                  )}
                  {blocked && (
                    <span className="mt-0.5 block text-xs text-danger">
                      {td.blocked}：{c.check.errors.join("；")}
                    </span>
                  )}
                  {[
                    ...c.check.warnings,
                    ...(same && !blocked ? [fill(td.sameName, { name: c.check.name })] : []),
                  ].map((w) => (
                    <span key={w} className="mt-0.5 block text-xs text-muted">
                      {w}
                    </span>
                  ))}
                </li>
              );
            })}
          </ul>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted">{td.dirName}</span>
            <input
              value={dirName}
              aria-invalid={!dirValid}
              disabled={installing}
              spellCheck={false}
              onChange={(e) => setDirName(e.target.value)}
              className={inputClass}
            />
            {!dirValid && <span className="text-xs text-danger">{td.dirNameInvalid}</span>}
          </label>
          {loadable.length === 0 && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {td.nothingLoadable}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-3 whitespace-pre-wrap break-words text-sm text-danger">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2 text-sm">
            <button
              type="button"
              disabled={installing}
              onClick={() => close(null)}
              className="rounded-full bg-hover px-4 py-1.5"
            >
              {t.cancel}
            </button>
            <button
              type="button"
              disabled={!dirValid || loadable.length === 0 || installing}
              onClick={() => void install(false)}
              className={primaryButtonClass}
            >
              {installing ? td.installing : td.install}
            </button>
          </div>
        </GlassDialogContent>
      </GlassDialog>

      <GlassDialog open={overwrite !== null} onOpenChange={(open) => !open && setOverwrite(null)}>
        <GlassDialogContent>
          <GlassDialogTitle>{fill(ts.overwrite.title, { name: overwrite ?? "" })}</GlassDialogTitle>
          <GlassDialogDescription>{ts.overwrite.description}</GlassDialogDescription>
          <div className="mt-5 flex justify-end gap-2 text-sm">
            <GlassDialogClose asChild>
              <button type="button" className="rounded-full bg-hover px-4 py-1.5">
                {t.cancel}
              </button>
            </GlassDialogClose>
            <button
              type="button"
              onClick={() => {
                setOverwrite(null);
                void install(true);
              }}
              className="rounded-full bg-hover px-4 py-1.5 font-medium text-danger ring-1 ring-danger/40"
            >
              {ts.overwrite.confirm}
            </button>
          </div>
        </GlassDialogContent>
      </GlassDialog>
    </>
  );
}
