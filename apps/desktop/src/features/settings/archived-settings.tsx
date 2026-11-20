"use client";

import { useRouter } from "next/navigation";
import { DropdownMenu } from "radix-ui";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import {
  GlassDialog,
  GlassDialogClose,
  GlassDialogContent,
  GlassDialogDescription,
  GlassDialogTitle,
} from "@/components/ui/glass-dialog";
import {
  GlassPopover,
  GlassPopoverContent,
  GlassPopoverSeparator,
  GlassPopoverTrigger,
} from "@/components/ui/glass-popover";
import { tabsForDeletion, useSessionsStore } from "@/features/sessions/sessions-store";
import { getPlatform, type SessionSummary, type WorkspaceInfo } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { Row, Section } from "./settings-section";

const t = strings.settings.archived;
const sessionText = strings.sessions;
const actionClass =
  "rounded-lg border border-border px-2.5 py-1.5 text-sm enabled:hover:bg-hover disabled:text-muted";

export function ArchivedSettings() {
  const router = useRouter();
  const [kind, setKind] = useState("all");
  const [sort, setSort] = useState("updated");
  const [project, setProject] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [defaultWorkspace, setDefaultWorkspace] = useState<string | null>(null);
  const [projectSession, setProjectSession] = useState<SessionSummary | null>(null);
  const [projectsFailed, setProjectsFailed] = useState(false);
  useEffect(() => {
    let active = true;
    getPlatform()
      .then(async (platform) => {
        const [projects, defaultPath] = await Promise.all([
          platform.workspaceList(),
          platform.sessionDefaultWorkspace(),
        ]);
        if (active) {
          setWorkspaces(projects);
          setDefaultWorkspace(defaultPath);
        }
      })
      .catch(() => {
        if (active) setProjectsFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionSummary[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      const keyword = query.trim();
      if (!keyword) {
        setResults(null);
        setSearching(false);
        return;
      }
      setResults(null);
      setSearching(true);
      setError("");
      setNotice("");
      try {
        const platform = await getPlatform();
        const matches = await platform.sessionSearch(null, keyword);
        if (active) setResults(matches.filter((session) => session.archived));
      } catch {
        if (active) setError(sessionText.searchFailed);
      } finally {
        if (active) setSearching(false);
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  async function changeSession(session: SessionSummary, remove: boolean) {
    if (busy || searching) return;
    setBusy(true);
    setPendingDelete(null);
    setNotice("");
    setError("");
    try {
      const platform = await getPlatform();
      if (remove) {
        const store = useSessionsStore.getState();
        for (const tab of tabsForDeletion(store.tabs, session)) store.closeTab(tab.id);
        await platform.sessionDelete(session.path);
      } else {
        await platform.sessionArchive(session.path, false);
      }
      setResults((current) => current?.filter((item) => item.path !== session.path) ?? null);
      setNotice(remove ? t.deleted : t.restored);
    } catch {
      setError(t.actionFailed);
    } finally {
      setBusy(false);
    }
  }

  const projectNames = new Map(workspaces.map((workspace) => [workspace.path, workspace.name]));
  for (const session of results ?? []) {
    if (session.workspace !== defaultWorkspace && !projectNames.has(session.workspace)) {
      projectNames.set(
        session.workspace,
        session.workspace.split(/[\\/]/).filter(Boolean).at(-1) || session.workspace,
      );
    }
  }

  const visible = results
    ?.filter((session) => !project || session.workspace === project)
    .sort((first, second) => {
      if (sort === "alphabetical") {
        return (
          (first.name || first.title || sessionText.untitled).localeCompare(
            second.name || second.title || sessionText.untitled,
            "zh-CN",
          ) || first.path.localeCompare(second.path)
        );
      }
      return (
        (sort === "created"
          ? second.createdAt - first.createdAt
          : second.updatedAt - first.updatedAt) || first.path.localeCompare(second.path)
      );
    });
  const menuItemClass =
    "relative mx-2 flex cursor-default items-center rounded-lg py-2 pl-8 pr-3 text-sm outline-none data-[highlighted]:bg-hover data-[disabled]:text-muted";
  const triggerClass =
    "flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm hover:bg-hover";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label={t.search}
          placeholder={t.search}
          value={query}
          disabled={busy}
          onChange={(event) => setQuery(event.currentTarget.value)}
          className="min-w-40 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        />

        <GlassPopover>
          <GlassPopoverTrigger asChild>
            <button type="button" className={triggerClass}>
              <Icon name="ask" size="sm" />
              {kind === "local" ? t.local : t.allChats}
              <Icon name="chevron-down" size="sm" />
            </button>
          </GlassPopoverTrigger>
          <GlassPopoverContent align="end">
            <DropdownMenu.Label className="px-5 py-1 text-xs text-muted">
              {t.type}
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={kind} onValueChange={setKind}>
              {(
                [
                  ["all", t.allChats],
                  ["local", t.local],
                  ["cloud", t.cloud],
                ] as const
              ).map(([value, label]) => (
                <DropdownMenu.RadioItem
                  key={value}
                  value={value}
                  disabled={value === "cloud"}
                  className={menuItemClass}
                >
                  <DropdownMenu.ItemIndicator className="absolute left-2">
                    <Icon name="check" size="sm" />
                  </DropdownMenu.ItemIndicator>
                  {label}
                  {value === "cloud" && <span className="ml-2 text-xs">{t.unavailable}</span>}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
            <GlassPopoverSeparator />
            <DropdownMenu.Label className="px-5 py-1 text-xs text-muted">
              {t.sort}
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={sort} onValueChange={setSort}>
              {(
                [
                  ["updated", t.updated],
                  ["created", t.created],
                  ["alphabetical", t.alphabetical],
                ] as const
              ).map(([value, label]) => (
                <DropdownMenu.RadioItem key={value} value={value} className={menuItemClass}>
                  <DropdownMenu.ItemIndicator className="absolute left-2">
                    <Icon name="check" size="sm" />
                  </DropdownMenu.ItemIndicator>
                  {label}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </GlassPopoverContent>
        </GlassPopover>
        <GlassPopover>
          <GlassPopoverTrigger asChild>
            <button type="button" className={triggerClass}>
              <Icon name="folder" size="sm" />
              {!project
                ? t.allProjects
                : project === defaultWorkspace
                  ? t.chats
                  : projectNames.get(project) || project}
              <Icon name="chevron-down" size="sm" />
            </button>
          </GlassPopoverTrigger>
          <GlassPopoverContent align="end">
            <DropdownMenu.RadioGroup value={project} onValueChange={setProject}>
              <DropdownMenu.RadioItem value="" className={menuItemClass}>
                <DropdownMenu.ItemIndicator className="absolute left-2">
                  <Icon name="check" size="sm" />
                </DropdownMenu.ItemIndicator>
                {t.allProjects}
              </DropdownMenu.RadioItem>
              <GlassPopoverSeparator />
              {Array.from(
                projectNames,
                ([path, name]) =>
                  path !== defaultWorkspace && (
                    <DropdownMenu.RadioItem key={path} value={path} className={menuItemClass}>
                      <DropdownMenu.ItemIndicator className="absolute left-2">
                        <Icon name="check" size="sm" />
                      </DropdownMenu.ItemIndicator>
                      {name}
                    </DropdownMenu.RadioItem>
                  ),
              )}
              <GlassPopoverSeparator />
              <DropdownMenu.RadioItem
                value={defaultWorkspace ?? "__unavailable__"}
                disabled={!defaultWorkspace}
                className={menuItemClass}
              >
                <DropdownMenu.ItemIndicator className="absolute left-2">
                  <Icon name="check" size="sm" />
                </DropdownMenu.ItemIndicator>
                {t.chats}
              </DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
          </GlassPopoverContent>
        </GlassPopover>
      </div>
      {projectsFailed && (
        <p role="status" className="text-xs text-muted">
          {t.projectsFailed}
        </p>
      )}

      <p className="text-xs text-muted">{t.hint}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      )}
      {searching && results === null && (
        <p role="status" className="text-sm">
          {sessionText.searching}
        </p>
      )}
      {visible?.length === 0 && <p className="text-sm text-muted">{t.empty}</p>}
      {Boolean(visible?.length) && (
        <Section title={strings.settings.groups.archived}>
          {visible?.map((session) => {
            const title = session.name || session.title || sessionText.untitled;
            return (
              <Row
                key={session.path}
                label={title}
                hint={
                  session.workspace === defaultWorkspace
                    ? t.standaloneChats
                    : projectNames.get(session.workspace) || session.workspace
                }
              >
                <div className="flex flex-wrap justify-end gap-1.5">
                  <button
                    type="button"
                    disabled={busy || searching}
                    className={actionClass}
                    onClick={() => {
                      if (useSessionsStore.getState().openSession(session)) router.push("/");
                      else setError(sessionText.tabsFull);
                    }}
                  >
                    {t.open}
                  </button>
                  <button
                    type="button"
                    className={actionClass}
                    onClick={() => setProjectSession(session)}
                  >
                    {t.project}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={actionClass}
                    onClick={() => void changeSession(session, false)}
                  >
                    {t.restore}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`${actionClass} text-danger`}
                    onClick={() => setPendingDelete(session)}
                  >
                    {sessionText.delete}
                  </button>
                </div>
              </Row>
            );
          })}
        </Section>
      )}

      <GlassDialog
        open={projectSession !== null}
        onOpenChange={(open) => !open && setProjectSession(null)}
      >
        <GlassDialogContent>
          <GlassDialogTitle>{t.project}</GlassDialogTitle>
          <GlassDialogDescription>
            {projectSession?.workspace === defaultWorkspace
              ? t.standaloneChats
              : projectNames.get(projectSession?.workspace ?? "") || t.project}
          </GlassDialogDescription>
          <p className="mt-3 break-all text-sm text-muted">{projectSession?.workspace}</p>
          <div className="mt-4 flex justify-end">
            <GlassDialogClose asChild>
              <button type="button" className={actionClass}>
                {sessionText.cancel}
              </button>
            </GlassDialogClose>
          </div>
        </GlassDialogContent>
      </GlassDialog>
      <GlassDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <GlassDialogContent>
          <GlassDialogTitle>{sessionText.deleteTitle}</GlassDialogTitle>
          <GlassDialogDescription>{sessionText.deleteDescription}</GlassDialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <GlassDialogClose asChild>
              <button type="button" className={actionClass}>
                {sessionText.cancel}
              </button>
            </GlassDialogClose>
            <button
              type="button"
              className={`${actionClass} text-danger`}
              onClick={() => pendingDelete && void changeSession(pendingDelete, true)}
            >
              {sessionText.deleteConfirm}
            </button>
          </div>
        </GlassDialogContent>
      </GlassDialog>
    </>
  );
}
