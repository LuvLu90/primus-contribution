"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import {
  GlassDialog,
  GlassDialogClose,
  GlassDialogContent,
  GlassDialogDescription,
  GlassDialogTitle,
} from "@/components/ui/glass-dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/glass-tabs";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import {
  type CliOutput,
  getPlatform,
  MCP_CONFLICT,
  type McpConfigFile,
  PlatformError,
} from "@/lib/platform";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { Badge, errorText } from "../settings/account-models";
import {
  DEFAULT_EXPOSURE,
  formatPairs,
  isRecord,
  joinCommandLine,
  listServers,
  MCP_EXPOSURES,
  type McpExposure,
  type McpListResult,
  type McpServerView,
  type McpTransport,
  parseMcpDocument,
  parseMcpList,
  parsePairs,
  parsePastedServers,
  removeServer,
  setServer,
  setServerEnabled,
  splitCommandLine,
  validServerName,
} from "./mcp-config";
import {
  buttonClass,
  cardClass,
  fill,
  iconButtonClass,
  inputClass,
  primaryButtonClass,
} from "./ui";

// 能力中心·MCP（ADR 0017）：编辑用户级 mcp.json（列出、添加——填写或粘贴 JSON、编辑、删除、启停），
// 测试连接（Core `mcp list --json`）与 OAuth 登录 / 退出（Core `mcp login` / `logout`，Core 自己打开浏览器）。
// 每次修改都基于最近读出的原文与版本：文件在别处被改过时薄壳以 `conflict` 拒绝，这里重新读取后请用户再操作一次。

const t = strings.settings.capabilities;
const tm = t.mcp;
const td = tm.dialog;

/** mcp.json 在别处被改过：界面已重新读取，编辑中的内容基于旧文件，需要重新打开 */
class McpConflictError extends Error {}

/** 命令行调用失败时给用户看的说明：超时，或 stderr / stdout 的最后几行 */
export function cliFailure(out: CliOutput): string {
  if (out.timedOut) return tm.timedOut;
  const text = (out.stderr || out.stdout).trim();
  return text
    ? text.split("\n").slice(-5).join("\n")
    : fill(tm.exitCode, { code: out.code ?? "-" });
}

export function McpSettings() {
  const [file, setFile] = useState<McpConfigFile | null>(null);
  const fileRef = useRef<McpConfigFile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ title: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<McpListResult | null>(null);
  const [editing, setEditing] = useState<McpServerView | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<McpServerView | null>(null);

  const apply = (f: McpConfigFile) => {
    fileRef.current = f;
    setFile(f);
  };

  const reload = async () => {
    try {
      apply(await (await getPlatform()).mcpConfigRead());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e, tm.loadFailed));
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时读取一次
  useEffect(() => {
    void reload();
  }, []);

  let parseError: string | null = null;
  let servers: McpServerView[] = [];
  if (file) {
    try {
      servers = listServers(parseMcpDocument(file.text));
    } catch (e) {
      parseError = errorText(e, tm.parseFailed);
    }
  }

  /** 基于最近读出的原文改写并保存；版本冲突时重新读取并报错 */
  const save = async (mutate: (text: string | null) => string) => {
    const current = fileRef.current;
    if (!current) throw new Error(tm.loadFailed);
    const next = mutate(current.text);
    try {
      const version = await (await getPlatform()).mcpConfigWrite(next, current.version);
      apply({ ...current, text: next, version });
      // 测试结果按名字对应，配置变了就不再可信：需要重新测试
      setReport(null);
    } catch (e) {
      if (e instanceof PlatformError && e.code === MCP_CONFLICT) {
        await reload();
        throw new McpConflictError(tm.conflict);
      }
      throw e;
    }
  };

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

  const test = () =>
    run("test", tm.testFailed, async () => {
      setReport(null);
      setReport(parseMcpList(await (await getPlatform()).mcpList()));
    });

  const toggle = (s: McpServerView, enabled: boolean) =>
    run(s.name, tm.saveFailed, () => save((text) => setServerEnabled(text, s.name, enabled)));

  const login = (s: McpServerView) =>
    run(s.name, tm.loginFailed, async () => {
      setNotice(tm.loggingIn);
      const out = await (await getPlatform()).mcpLogin(s.name);
      if (out.code !== 0 || out.timedOut) {
        setNotice(null);
        throw new Error(cliFailure(out));
      }
      setNotice(fill(tm.loginDone, { name: s.name }));
    });

  const logout = (s: McpServerView) =>
    run(s.name, tm.logoutFailed, async () => {
      const out = await (await getPlatform()).mcpLogout(s.name);
      if (out.code !== 0 || out.timedOut) throw new Error(cliFailure(out));
      setNotice(fill(tm.logoutDone, { name: s.name }));
    });

  const confirmDelete = () => {
    const s = pendingDelete;
    setPendingDelete(null);
    if (s) void run(s.name, tm.saveFailed, () => save((text) => removeServer(text, s.name)));
  };

  if (!file && !loadError) return <p className="text-sm text-muted">{tm.loading}</p>;
  const editable = file !== null && parseError === null;
  const reports = new Map((report?.servers ?? []).map((r) => [r.name, r]));

  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-xs font-medium text-muted">{tm.title}</h3>
      {file && (
        <p className="truncate px-1 text-xs text-muted">{fill(tm.file, { path: file.path })}</p>
      )}
      {(loadError || parseError) && (
        <div role="alert" className="rounded-2xl px-4 py-3 text-sm ring-1 ring-danger/40">
          <p className="font-medium text-danger">{loadError ?? tm.parseFailed}</p>
          {parseError && <p className="mt-1 text-muted">{parseError}</p>}
          <button type="button" onClick={() => void reload()} className={cn(buttonClass, "mt-2")}>
            <Icon name="refresh" size="sm" />
            {tm.reload}
          </button>
        </div>
      )}
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
      {report && (report.errors.length > 0 || report.note) && (
        <div className="rounded-2xl px-4 py-3 text-sm ring-1 ring-danger/40">
          {report.errors.length > 0 && (
            <>
              <p className="font-medium text-danger">{tm.configErrors}</p>
              {report.errors.map((e) => (
                <p key={e} className="mt-1 break-words text-xs text-muted">
                  {e}
                </p>
              ))}
            </>
          )}
          {report.note && <p className="mt-1 text-xs text-muted">{report.note}</p>}
        </div>
      )}
      <div className={cardClass}>
        {editable && servers.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted">{tm.empty}</p>
        )}
        {servers.length > 0 && (
          <ul aria-label={tm.title} className="divide-y divide-border">
            {servers.map((s) => {
              const r = reports.get(s.name);
              return (
                <li key={s.name} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                      <span className="truncate font-medium">{s.name}</span>
                      {s.transport && <Badge>{tm.transports[s.transport]}</Badge>}
                      <Tooltip content={tm.exposureHints[s.exposure as McpExposure] ?? s.exposure}>
                        <span>
                          <Badge>{tm.exposures[s.exposure as McpExposure] ?? s.exposure}</Badge>
                        </span>
                      </Tooltip>
                    </p>
                    <Tooltip content={s.target}>
                      <p className="mt-0.5 truncate text-xs text-muted">{s.target}</p>
                    </Tooltip>
                    {s.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted">{s.description}</p>
                    )}
                    {s.error && (
                      <p className="mt-0.5 text-xs text-danger">
                        {tm.invalid}：{s.error}
                      </p>
                    )}
                    {r && <ServerState state={r.state} tools={r.tools.length} error={r.error} />}
                    {s.transport === "http" && editable && (
                      <div className="mt-1 flex gap-3 text-xs">
                        <button
                          type="button"
                          aria-label={fill(tm.loginLabel, { name: s.name })}
                          disabled={busy !== null}
                          onClick={() => void login(s)}
                          className="text-accent hover:underline disabled:opacity-50"
                        >
                          {tm.login}
                        </button>
                        <button
                          type="button"
                          aria-label={fill(tm.logoutLabel, { name: s.name })}
                          disabled={busy !== null}
                          onClick={() => void logout(s)}
                          className="text-muted hover:underline disabled:opacity-50"
                        >
                          {tm.logout}
                        </button>
                      </div>
                    )}
                  </div>
                  <Switch
                    ariaLabel={fill(tm.enable, { name: s.name })}
                    checked={s.enabled}
                    disabled={busy !== null || !editable}
                    onCheckedChange={(enabled) => void toggle(s, enabled)}
                  />
                  <Tooltip content={t.edit}>
                    <button
                      type="button"
                      aria-label={fill(tm.editLabel, { name: s.name })}
                      disabled={busy !== null || !editable}
                      onClick={() => setEditing(s)}
                      className={iconButtonClass}
                    >
                      <Icon name="pen" />
                    </button>
                  </Tooltip>
                  <Tooltip content={t.delete}>
                    <button
                      type="button"
                      aria-label={fill(tm.deleteLabel, { name: s.name })}
                      disabled={busy !== null || !editable}
                      onClick={() => setPendingDelete(s)}
                      className={cn(iconButtonClass, "hover:text-danger")}
                    >
                      <Icon name="trash" />
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <button
            type="button"
            onClick={() => setEditing("new")}
            disabled={busy !== null || !editable}
            className={buttonClass}
          >
            <Icon name="plus" size="sm" />
            {tm.add}
          </button>
          <Tooltip content={tm.testHint}>
            <button
              type="button"
              onClick={() => void test()}
              disabled={busy !== null || !file}
              className={buttonClass}
            >
              <Icon name={busy === "test" ? "loader" : "activity"} size="sm" />
              {busy === "test" ? tm.testing : tm.test}
            </button>
          </Tooltip>
        </div>
      </div>
      <p className="px-1 text-xs text-muted">{t.newSessionHint}</p>

      {editing !== null && file && (
        <ServerDialog
          server={editing === "new" ? null : editing}
          existing={servers.map((s) => s.name)}
          onClose={() => setEditing(null)}
          onSubmit={async (mutate) => {
            try {
              await save(mutate);
            } catch (e) {
              // 冲突：对话框里的条目基于旧文件，关掉对话框，让用户在新内容上重新编辑
              if (!(e instanceof McpConflictError)) throw e;
              setActionError({ title: tm.saveFailed, message: e.message });
            }
            setEditing(null);
          }}
        />
      )}

      <GlassDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <GlassDialogContent>
          <GlassDialogTitle>
            {pendingDelete ? fill(tm.deleteTitle, { name: pendingDelete.name }) : null}
          </GlassDialogTitle>
          <GlassDialogDescription>{tm.deleteDescription}</GlassDialogDescription>
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
    </section>
  );
}

function ServerState({ state, tools, error }: { state: string; tools: number; error?: string }) {
  const label =
    state === "connected"
      ? fill(tm.states.connected, { n: tools })
      : (tm.states[state as keyof typeof tm.states] ?? state);
  const ok = state === "connected" || state === "disabled";
  return (
    <div className="mt-1 text-xs">
      <p className={cn("flex items-center gap-1", ok ? "text-muted" : "text-danger")}>
        <Icon name={state === "connected" ? "check-circle" : ok ? "minus" : "alert-circle"} />
        {label}
      </p>
      {error && (
        <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-muted">{error}</p>
      )}
    </div>
  );
}

/** 表单管理的字段：保存时先从原条目去掉，再按表单写回；其余字段（oauth、timeout、enabled 等）保留 */
const FORM_KEYS = [
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "description",
  "exposure",
];

interface FormState {
  name: string;
  transport: McpTransport;
  command: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  description: string;
  exposure: McpExposure;
}

/** 条目 → 表单；传输方式与暴露方式按条目本身判断 */
function formFrom(name: string, entry: unknown): FormState {
  const e = isRecord(entry) ? entry : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const args = Array.isArray(e.args)
    ? e.args.filter((a): a is string => typeof a === "string")
    : [];
  const exposure = str(e.exposure) === "codemode-deferred" ? DEFAULT_EXPOSURE : str(e.exposure);
  return {
    name,
    transport: typeof e.url === "string" ? "http" : "stdio",
    command: typeof e.command === "string" ? joinCommandLine([e.command, ...args]) : "",
    env: formatPairs(e.env, "="),
    cwd: str(e.cwd),
    url: str(e.url),
    headers: formatPairs(e.headers, ":"),
    description: str(e.description),
    exposure: (MCP_EXPOSURES as readonly string[]).includes(exposure)
      ? (exposure as McpExposure)
      : DEFAULT_EXPOSURE,
  };
}

/**
 * 表单 → 条目；`base` 是编辑前的条目。表单文本没改动的字段（命令与参数、环境变量、请求头）沿用 `base` 中的原值，
 * 不经文本往返（值里的首尾空白、换行等无法在表单文本中无损表示）。填写不完整时抛出中文错误
 */
export function entryFromForm(form: FormState, base: unknown): Record<string, unknown> {
  const original: Record<string, unknown> = isRecord(base) ? structuredClone(base) : {};
  const initial = formFrom(form.name, original);
  const entry: Record<string, unknown> = { ...original };
  for (const k of FORM_KEYS) delete entry[k];
  const keep = (field: keyof FormState, ...keys: string[]) => {
    if (form[field] !== initial[field] || form.transport !== initial.transport) return false;
    for (const k of keys) if (k in original) entry[k] = original[k];
    return true;
  };
  if (form.transport === "stdio") {
    delete entry.oauth;
    delete entry.auth;
    if (!keep("command", "command", "args")) {
      const [command, ...args] = splitCommandLine(form.command);
      if (!command) throw new Error(td.commandRequired);
      entry.command = command;
      if (args.length) entry.args = args;
    } else if (typeof entry.command !== "string" || !entry.command)
      throw new Error(td.commandRequired);
    if (!keep("env", "env")) {
      const env = parsePairs(form.env, "=", `${td.env}：`);
      if (Object.keys(env).length) entry.env = env;
    }
    if (form.cwd.trim()) entry.cwd = form.cwd.trim();
  } else {
    if (!form.url.trim()) throw new Error(td.urlRequired);
    entry.url = form.url.trim();
    if (!keep("headers", "headers")) {
      const headers = parsePairs(form.headers, ":", `${td.headers}：`);
      if (Object.keys(headers).length) entry.headers = headers;
    }
  }
  if (form.description.trim()) entry.description = form.description.trim();
  if (form.exposure !== DEFAULT_EXPOSURE) entry.exposure = form.exposure;
  return entry;
}

type Mode = "form" | "json";

function ServerDialog({
  server,
  existing,
  onClose,
  onSubmit,
}: {
  server: McpServerView | null;
  existing: string[];
  onClose: () => void;
  onSubmit: (mutate: (text: string | null) => string) => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("form");
  const [form, setForm] = useState<FormState>(() => formFrom(server?.name ?? "", server?.entry));
  const [json, setJson] = useState(() => (server ? JSON.stringify(server.entry, null, 2) : ""));
  /** 编辑的基底：最初是文件中的条目，从 JSON 切回表单时换成 JSON 里的条目（表单不管的字段以它为准） */
  const [base, setBase] = useState<unknown>(() => server?.entry);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = {
    name: useId(),
    transport: useId(),
    command: useId(),
    env: useId(),
    cwd: useId(),
    url: useId(),
    headers: useId(),
    description: useId(),
    exposure: useId(),
    json: useId(),
    modes: useId(),
  };
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // 编辑时两种方式互相同步：表单 → JSON 保留表单不管的字段；JSON 解析不了时保留表单原样
  const switchMode = (next: Mode) => {
    if (server && next === "json" && mode === "form") {
      try {
        setJson(JSON.stringify(entryFromForm(form, base), null, 2));
      } catch {
        // 表单填写不完整：保留上次的 JSON
      }
    } else if (server && next === "form" && mode === "json") {
      try {
        const value: unknown = JSON.parse(json);
        if (isRecord(value)) {
          setBase(value);
          setForm(formFrom(form.name, value));
        }
      } catch {
        // JSON 无效：保留表单原样
      }
    }
    setMode(next);
  };

  // 粘贴 JSON 时预览将添加的服务器
  let pasted: {
    names: string[];
    unnamed: boolean;
    notes: string[];
    error: string | null;
  } | null = null;
  if (mode === "json" && !server && json.trim()) {
    try {
      const r = parsePastedServers(json);
      pasted = {
        names: r.servers.map(([n]) => n || form.name.trim()),
        // 按粘贴的原文判断，不看已代入的名称：否则输入第一个字符后名称框就消失了
        unnamed: r.servers.some(([n]) => n === ""),
        notes: r.notes,
        error: null,
      };
    } catch (e) {
      pasted = { names: [], unnamed: false, notes: [], error: errorText(e, td.json) };
    }
  }
  const needsName = mode === "form" || server !== null || (pasted?.unnamed ?? false);
  const nameInvalid = needsName && form.name.trim() !== "" && !validServerName(form.name.trim());

  /** 本次要写入的 [名字, 条目]；改名时的原名由 previous 给出 */
  const collect = (): [string, Record<string, unknown>][] => {
    const name = form.name.trim();
    if (mode === "form") return [[name, entryFromForm(form, base)]];
    if (server) {
      let value: unknown;
      try {
        value = JSON.parse(json);
      } catch (e) {
        throw new Error(errorText(e, td.json));
      }
      if (!isRecord(value)) throw new Error(td.json);
      return [[name, value]];
    }
    const r = parsePastedServers(json);
    return r.servers.map(([n, entry]) => {
      if (n) return [n, entry];
      if (!name) throw new Error(td.jsonNameNeeded);
      return [name, entry];
    });
  };

  const submit = async () => {
    setError(null);
    let entries: [string, Record<string, unknown>][];
    try {
      if (needsName && !validServerName(form.name.trim())) throw new Error(td.nameInvalid);
      entries = collect();
    } catch (e) {
      setError(errorText(e, tm.saveFailed));
      return;
    }
    setSaving(true);
    try {
      await onSubmit((text) => {
        let next = text;
        for (const [name, entry] of entries) {
          // 编辑：替换原条目（可改名）；粘贴 JSON：同名的服务器被替换；表单添加：同名报冲突
          const previous = server
            ? server.name
            : mode === "json" && existing.includes(name)
              ? name
              : undefined;
          next = setServer(next, name, entry, previous);
        }
        return next ?? "";
      });
    } catch (e) {
      setError(errorText(e, tm.saveFailed));
    } finally {
      setSaving(false);
    }
  };

  const label = (id: string, text: string) => (
    <label htmlFor={id} className="mb-1 block text-xs text-muted">
      {text}
    </label>
  );

  return (
    <GlassDialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <GlassDialogContent>
        <GlassDialogTitle>{server ? td.editTitle : td.addTitle}</GlassDialogTitle>
        <GlassDialogDescription className="sr-only">
          {server ? td.editTitle : td.addTitle}
        </GlassDialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="scroll-thin mt-3 flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1"
        >
          <Tabs value={mode} onValueChange={(v) => switchMode(v as Mode)}>
            <TabsList aria-label={td.modesLabel}>
              {(["form", "json"] as const).map((m) => (
                <TabsTrigger key={m} value={m}>
                  {td.modes[m]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {needsName && (
            <div>
              {label(ids.name, td.name)}
              <input
                id={ids.name}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder={td.namePlaceholder}
                spellCheck={false}
                aria-invalid={nameInvalid}
                className={inputClass}
              />
              {nameInvalid && <p className="mt-1 text-xs text-danger">{td.nameInvalid}</p>}
            </div>
          )}
          {mode === "form" ? (
            <>
              <div>
                {label(ids.transport, td.transport)}
                <select
                  id={ids.transport}
                  value={form.transport}
                  onChange={(e) => set("transport", e.target.value as McpTransport)}
                  className={inputClass}
                >
                  {(["stdio", "http"] as const).map((x) => (
                    <option key={x} value={x}>
                      {tm.transports[x]}
                    </option>
                  ))}
                </select>
              </div>
              {form.transport === "stdio" ? (
                <>
                  <div>
                    {label(ids.command, td.command)}
                    <input
                      id={ids.command}
                      value={form.command}
                      onChange={(e) => set("command", e.target.value)}
                      placeholder={td.commandPlaceholder}
                      spellCheck={false}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    {label(ids.env, td.env)}
                    <textarea
                      id={ids.env}
                      rows={3}
                      value={form.env}
                      onChange={(e) => set("env", e.target.value)}
                      placeholder={td.envPlaceholder}
                      spellCheck={false}
                      className={cn(inputClass, "font-mono text-xs")}
                    />
                  </div>
                  <div>
                    {label(ids.cwd, td.cwd)}
                    <input
                      id={ids.cwd}
                      value={form.cwd}
                      onChange={(e) => set("cwd", e.target.value)}
                      placeholder={td.cwdPlaceholder}
                      spellCheck={false}
                      className={inputClass}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    {label(ids.url, td.url)}
                    <input
                      id={ids.url}
                      value={form.url}
                      onChange={(e) => set("url", e.target.value)}
                      placeholder={td.urlPlaceholder}
                      spellCheck={false}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    {label(ids.headers, td.headers)}
                    <textarea
                      id={ids.headers}
                      rows={3}
                      value={form.headers}
                      onChange={(e) => set("headers", e.target.value)}
                      placeholder={td.headersPlaceholder}
                      spellCheck={false}
                      className={cn(inputClass, "font-mono text-xs")}
                    />
                    <p className="mt-1 text-xs text-muted">{td.headersHint}</p>
                  </div>
                </>
              )}
              <p className="text-xs text-muted">{td.plaintextWarning}</p>
              <div>
                {label(ids.description, td.description)}
                <input
                  id={ids.description}
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder={td.descriptionPlaceholder}
                  className={inputClass}
                />
              </div>
              <div>
                {label(ids.exposure, td.exposure)}
                <select
                  id={ids.exposure}
                  value={form.exposure}
                  onChange={(e) => set("exposure", e.target.value as McpExposure)}
                  className={inputClass}
                >
                  {MCP_EXPOSURES.map((x) => (
                    <option key={x} value={x}>
                      {tm.exposures[x]}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted">{tm.exposureHints[form.exposure]}</p>
              </div>
            </>
          ) : (
            <div>
              {label(ids.json, td.json)}
              <textarea
                id={ids.json}
                rows={10}
                value={json}
                onChange={(e) => setJson(e.target.value)}
                placeholder={server ? undefined : td.jsonPlaceholder}
                spellCheck={false}
                className={cn(inputClass, "font-mono text-xs")}
              />
              <p className="mt-1 text-xs text-muted">{server ? td.jsonEditHint : td.jsonHint}</p>
              {pasted?.error && <p className="mt-1 text-xs text-danger">{pasted.error}</p>}
              {pasted && pasted.names.length > 0 && (
                <p className="mt-1 text-xs text-muted">
                  {fill(td.found, { names: pasted.names.map((n) => n || "?").join("、") })}
                </p>
              )}
              {pasted?.notes.map((n) => (
                <p key={n} className="mt-1 text-xs text-muted">
                  {n}
                </p>
              ))}
              <p className="mt-1 text-xs text-muted">{td.plaintextWarning}</p>
            </div>
          )}
          {error && (
            <p role="alert" className="whitespace-pre-wrap break-words text-sm text-danger">
              {error}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2 text-sm">
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              className="rounded-full bg-hover px-4 py-1.5"
            >
              {t.cancel}
            </button>
            <button type="submit" disabled={saving} className={primaryButtonClass}>
              {saving ? td.saving : td.save}
            </button>
          </div>
        </form>
      </GlassDialogContent>
    </GlassDialog>
  );
}
