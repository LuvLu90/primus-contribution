"use client";

import { useEffect, useId, useState } from "react";
import { Icon } from "@/components/icons";
import {
  GlassDialog,
  GlassDialogClose,
  GlassDialogContent,
  GlassDialogDescription,
  GlassDialogTitle,
} from "@/components/ui/glass-dialog";
import { strings } from "@/lib/strings";
import { Section } from "./settings-section";

const t = strings.settings.ssh;
const buttonClass =
  "rounded-lg border border-border px-3 py-1.5 text-sm enabled:hover:bg-hover disabled:text-muted";
const fieldClass = "w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm";
interface Server {
  id: string;
  name: string;
  address: string;
  port: string;
  username: string;
  example: boolean;
}
const empty = { name: "", address: "", port: "22", username: "" };

export function AdvancedSettings({ enabled }: { enabled: boolean }) {
  const prefix = useId();
  const [servers, setServers] = useState<Server[]>([
    {
      id: "teaching",
      name: t.teaching,
      address: "teaching.example.com",
      port: "22",
      username: "teacher",
      example: true,
    },
    {
      id: "resources",
      name: t.resources,
      address: "resources.example.com",
      port: "22",
      username: "teacher",
      example: true,
    },
  ]);
  const [selected, setSelected] = useState<Server | "new" | null>(null);
  const [draft, setDraft] = useState(empty);
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const creating = selected === "new";

  useEffect(() => {
    if (!enabled) {
      setSelected(null);
      setPassword("");
      setNotice("");
    }
  }, [enabled]);

  function close() {
    setSelected(null);
    setPassword("");
    setNotice("");
  }
  function open(server: Server | "new") {
    setDraft(server === "new" ? empty : server);
    setPassword("");
    setNotice("");
    setSelected(server);
  }

  return (
    <>
      <fieldset
        disabled={!enabled}
        aria-label={t.title}
        className="min-w-0"
        style={{ filter: enabled ? undefined : "grayscale(1)", opacity: enabled ? 1 : 0.45 }}
      >
        <Section title={t.title}>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p className="text-xs text-muted">{t.hint}</p>
            <button type="button" className={buttonClass} onClick={() => open("new")}>
              <span className="flex items-center gap-1.5">
                <Icon name="plus" size="sm" />
                {t.create}
              </span>
            </button>
          </div>
          {servers.map((server) => (
            <button
              key={server.id}
              type="button"
              className="flex w-full items-center gap-3 px-4 py-4 text-left enabled:hover:bg-hover disabled:cursor-not-allowed"
              onClick={() => open(server)}
            >
              <Icon name="server" size="md" className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {server.name}
                  {server.example && (
                    <span className="text-xs font-normal text-muted">{t.example}</span>
                  )}
                </span>
                <span className="mt-1 block break-all text-xs text-muted">
                  {server.address}:{server.port}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted">{t.disconnected}</span>
              <Icon name="chevron-right" size="sm" className="shrink-0 text-muted" />
            </button>
          ))}
        </Section>
      </fieldset>
      <GlassDialog
        open={enabled && selected !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <GlassDialogContent>
          <GlassDialogTitle>{creating ? t.create : draft.name}</GlassDialogTitle>
          <GlassDialogDescription>{t.dialogHint}</GlassDialogDescription>
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!enabled) return;
              if (creating) {
                setServers((previous) => [
                  ...previous,
                  {
                    ...draft,
                    name: draft.name.trim(),
                    address: draft.address.trim(),
                    username: draft.username.trim(),
                    id: crypto.randomUUID(),
                    example: false,
                  },
                ]);
                close();
              } else {
                setPassword("");
                setNotice(t.unavailable);
              }
            }}
          >
            {(["name", "address", "port", "username"] as const).map((field) => (
              <div key={field}>
                <label htmlFor={prefix + field} className="mb-1 block text-sm">
                  {t[field]}
                </label>
                <input
                  id={prefix + field}
                  className={fieldClass}
                  value={draft[field]}
                  readOnly={!creating}
                  required
                  type={field === "port" ? "number" : "text"}
                  min={field === "port" ? 1 : undefined}
                  max={field === "port" ? 65535 : undefined}
                  pattern={field === "port" ? undefined : ".*\\S.*"}
                  autoComplete="off"
                  onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                />
              </div>
            ))}
            {!creating && (
              <div>
                <label htmlFor={`${prefix}password`} className="mb-1 block text-sm">
                  {t.password}
                </label>
                <input
                  id={`${prefix}password`}
                  type="password"
                  value={password}
                  autoComplete="off"
                  className={fieldClass}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            )}
            {notice && (
              <p role="status" className="text-sm text-muted">
                {notice}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <GlassDialogClose asChild>
                <button type="button" className={buttonClass}>
                  {t.cancel}
                </button>
              </GlassDialogClose>
              <button type="submit" className={buttonClass}>
                {creating ? t.add : t.login}
              </button>
            </div>
          </form>
        </GlassDialogContent>
      </GlassDialog>
    </>
  );
}
