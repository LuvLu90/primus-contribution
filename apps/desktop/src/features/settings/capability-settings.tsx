"use client";

import { useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/glass-tabs";
import { getPlatform, type TrustDetails, type WorkspaceInfo } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { useAppStore } from "@/stores/app-store";
import { McpSettings } from "../capabilities/mcp-settings";
import { SkillsSettings } from "../capabilities/skills-settings";
import { Row, Section } from "./settings-section";

const t = strings.settings.capabilityExtras;
const categories = ["skills", "mcp", "plugins", "connectors"] as const;

export function CapabilitySettings() {
  const [tab, setTab] = useState("skills");
  const [visited, setVisited] = useState(() => new Set(["skills"]));
  const currentWorkspace = useAppStore((state) => state.workspace);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [inspection, setInspection] = useState<{ path: string; details: TrustDetails | null }>();
  const choices =
    currentWorkspace && !workspaces?.some((workspace) => workspace.path === currentWorkspace.path)
      ? [currentWorkspace, ...(workspaces ?? [])]
      : (workspaces ?? []);
  const path = currentWorkspace?.path ?? choices[0]?.path ?? "";
  const trusted = choices.some((workspace) => workspace.path === path && workspace.trusted);
  const inspected = inspection?.path === path ? inspection : undefined;

  useEffect(() => {
    let active = true;
    getPlatform()
      .then((platform) => platform.workspaceList())
      .then((items) => {
        if (active) setWorkspaces(items);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!path) return;
    let active = true;
    getPlatform()
      .then((platform) => platform.workspaceInspect(path))
      .then((details) => {
        if (active) setInspection({ path, details });
      })
      .catch(() => {
        if (active) setInspection({ path, details: null });
      });
    return () => {
      active = false;
    };
  }, [path]);

  const items = {
    skills: inspected?.details?.skills,
    mcp: inspected?.details?.mcpServers,
    plugins: inspected?.details?.extensions,
    connectors: undefined,
  };

  return (
    <Tabs
      className="w-full min-w-0 gap-5"
      value={tab}
      onValueChange={(value) => {
        setTab(value);
        setVisited((previous) => (previous.has(value) ? previous : new Set([...previous, value])));
      }}
    >
      <TabsList aria-label={strings.settings.groups.capabilities} className="self-start">
        {categories.map((category) => (
          <TabsTrigger key={category} value={category}>
            {t.tabs[category]}
          </TabsTrigger>
        ))}
      </TabsList>
      {categories.map((category) => {
        if (!visited.has(category)) return null;
        const entries = items[category];
        let status: string = t.empty;
        if (category === "connectors") status = t.unavailable;
        else if (inspected?.details === null || (!path && failed)) status = t.loadFailed;
        else if (!workspaces && !failed && !path) status = t.loading;
        else if (!path) status = t.selectWorkspace;
        else if (!inspected) status = t.loading;
        return (
          <TabsContent
            key={category}
            value={category}
            forceMount
            hidden={tab !== category}
            className="min-w-0 w-full space-y-5"
          >
            {category === "skills" && <SkillsSettings />}
            {category === "mcp" && <McpSettings />}
            <Section title={t.tabs[category]}>
              <p className="px-4 py-3 text-sm text-muted">{t.descriptions[category]}</p>
              {entries?.length ? (
                Array.from(new Set(entries)).map((name) => (
                  <Row key={name} label={name} hint={trusted ? t.declared : t.untrusted}>
                    <button
                      type="button"
                      disabled
                      aria-label={t.unavailable}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted"
                    >
                      {t.unavailable}
                    </button>
                  </Row>
                ))
              ) : (
                <p role="status" className="px-4 py-3 text-sm text-muted">
                  {status}
                </p>
              )}
            </Section>
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
