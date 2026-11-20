"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/glass-tabs";
import { useSessionsStore } from "@/features/sessions/sessions-store";
import { type AuthStatus, getPlatform, type SessionSummary } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { Section } from "./settings-section";

const t = strings.settings.usage;
const integer = new Intl.NumberFormat("zh-CN");
const dateTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });
const monthName = new Intl.DateTimeFormat("zh-CN", { month: "short" });
const metrics = ["daily", "weekly", "cumulative"] as const;
type Metric = (typeof metrics)[number];
const colors = ["bg-usage-0", "bg-usage-1", "bg-usage-2", "bg-usage-3", "bg-usage-4"] as const;
const statuses = { success: t.success, failed: t.failed, cancelled: t.cancelled };
const fieldClass = "rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-fg";

interface Cost {
  amount: number;
  currency: string;
  estimated: boolean;
}

export interface ModelCall {
  id: string;
  timestamp: number;
  model: string;
  input: number | null;
  output: number | null;
  total: number | null;
  cost: Cost | null;
  status: keyof typeof statuses;
  session?: Pick<SessionSummary, "path" | "id" | "workspace">;
}

function dayKey(date: Date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
}

function formatNumber(value: number | null) {
  return value === null ? t.noData : integer.format(value);
}

function formatCost(cost: Cost) {
  const amount = new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: cost.currency,
    currencyDisplay: "code",
    maximumFractionDigits: 6,
  }).format(cost.amount);
  return cost.estimated ? `${amount} · ${t.estimate}` : amount;
}

function getTotals(calls: readonly ModelCall[] | null) {
  if (!calls?.length)
    return { requests: calls?.length ?? null, tokens: null, cost: t.noData, costAmount: null };
  let tokens = 0;
  let tokensKnown = true;
  let costKnown = true;
  const costs = new Map<string, Cost>();
  for (const call of calls) {
    if (call.total === null) tokensKnown = false;
    else tokens += call.total;
    if (call.cost === null) {
      costKnown = false;
      continue;
    }
    const previous = costs.get(call.cost.currency);
    costs.set(call.cost.currency, {
      currency: call.cost.currency,
      amount: (previous?.amount ?? 0) + call.cost.amount,
      estimated: Boolean(previous?.estimated || call.cost.estimated),
    });
  }
  return {
    requests: calls.length,
    tokens: tokensKnown ? tokens : null,
    cost: costKnown ? Array.from(costs.values(), formatCost).join(" + ") : t.noData,
    costAmount:
      costKnown && costs.size === 1 ? (costs.values().next().value?.amount ?? null) : null,
  };
}

export function UsageSettings({
  calls = null,
  completedAt = null,
}: {
  calls?: readonly ModelCall[] | null;
  completedAt?: readonly number[] | null;
}) {
  const router = useRouter();
  const [metric, setMetric] = useState<Metric>("daily");
  const swipe = useRef<{ pointerId: number; x: number; metric: Metric } | null>(null);
  const [date, setDate] = useState("");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [account, setAccount] = useState<AuthStatus | null>(null);
  const [accountError, setAccountError] = useState(false);

  useEffect(() => {
    let active = true;
    getPlatform()
      .then((platform) => platform.authStatus())
      .then((status) => {
        if (active) setAccount(status);
      })
      .catch(() => {
        if (active) setAccountError(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const [sessionError, setSessionError] = useState(false);
  const [today] = useState(() => new Date());

  const start = new Date(today.getFullYear(), today.getMonth() - 11, 1);
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const inPeriod = (timestamp: number) => timestamp >= start.getTime() && timestamp < end.getTime();
  const periodCalls = calls?.filter((call) => inPeriod(call.timestamp)) ?? null;
  const filtered = periodCalls
    ?.filter((call) => !date || dayKey(new Date(call.timestamp)) === date)
    .sort((first, second) => second.timestamp - first.timestamp);
  const totals = getTotals(periodCalls);
  const cards = [
    { label: t.cost, icon: "chart", value: totals.cost },
    { label: t.requests, icon: "activity", value: formatNumber(totals.requests) },
    { label: t.tokens, icon: "gauge", value: formatNumber(totals.tokens) },
    {
      label: t.tasks,
      icon: "check-circle",
      value: formatNumber(completedAt?.filter(inPeriod).length ?? null),
    },
  ] as const;

  const byDay = new Map<string, ModelCall[]>();
  for (const call of periodCalls ?? []) {
    const key = dayKey(new Date(call.timestamp));
    const existing = byDay.get(key);
    if (existing) existing.push(call);
    else byDay.set(key, [call]);
  }

  const byWeek = new Map<string, ModelCall[]>();
  function weekStart(date: Date) {
    const monday = new Date(date);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return monday;
  }
  for (const call of periodCalls ?? []) {
    const key = dayKey(weekStart(new Date(call.timestamp)));
    const entries = byWeek.get(key);
    if (entries) entries.push(call);
    else byWeek.set(key, [call]);
  }
  const cumulative = new Map<string, number | null>();
  let runningTokens = 0;
  let tokensKnown = true;
  for (const cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + 1)) {
    const key = dayKey(cursor);
    const daily = getTotals(byDay.get(key) ?? []);
    if (daily.requests && daily.tokens === null) tokensKnown = false;
    runningTokens += daily.tokens ?? 0;
    cumulative.set(key, periodCalls && tokensKnown ? runningTokens : null);
  }
  const months = Array.from({ length: 12 }, (_, offset) => {
    const month = new Date(today.getFullYear(), today.getMonth() - offset, 1);
    const length = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const leading = (month.getDay() + 6) % 7;
    const weeks = Math.ceil((leading + length) / 7);
    const days = Array.from({ length: weeks * 7 }, (_, index) => {
      const day = index - leading + 1;
      const date = new Date(month.getFullYear(), month.getMonth(), day);
      const key = dayKey(date);
      if (day < 1 || day > length) return { key, totals: null, value: null, range: "" };

      const daily = getTotals(byDay.get(key) ?? (periodCalls && date < end ? [] : null));
      const monday = weekStart(date);
      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 6);
      const weekly = getTotals(byWeek.get(dayKey(monday)) ?? (periodCalls ? [] : null));
      const value =
        date >= end
          ? null
          : metric === "daily"
            ? daily.tokens
            : metric === "weekly"
              ? weekly.tokens
              : (cumulative.get(key) ?? null);
      const range =
        metric === "weekly"
          ? `${dayKey(monday < start ? start : monday)} — ${dayKey(sunday >= end ? today : sunday)}`
          : metric === "cumulative"
            ? `${dayKey(start)} — ${key}`
            : key;
      return { key, totals: daily, value, range };
    });
    return { key: dayKey(month), name: monthName.format(month), weeks, days };
  });
  const maximum = Math.max(0, ...months.flatMap(({ days }) => days.map(({ value }) => value ?? 0)));

  function openSession(session: NonNullable<ModelCall["session"]>) {
    if (useSessionsStore.getState().openSession(session)) router.push("/");
    else setSessionError(true);
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-3 py-3">
        <span
          role="img"
          aria-label={strings.settings.account.avatar}
          className="grid size-16 scale-[1.2] place-items-center rounded-full bg-hover text-muted"
        >
          <Icon name="user" size="xl" />
        </span>
        <p className="text-xs text-muted">
          {accountError
            ? strings.settings.account.loadFailed
            : !account
              ? strings.settings.account.loading
              : account.loggedIn
                ? account.account?.name || strings.settings.account.notProvided
                : strings.settings.account.notSignedIn}
        </p>
      </div>
      <dl className="grid grid-cols-4 gap-2">
        {cards.map(({ label, icon, value }) => (
          <div key={label} className="min-w-0 rounded-xl border border-border bg-surface/70 p-3">
            <dt className="flex items-center gap-1.5 text-xs text-muted">
              <Icon name={icon} size="sm" className="shrink-0" />
              {label}
            </dt>
            <dd className="mt-2 break-words font-semibold text-base tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <section
        aria-labelledby="usage-heatmap-heading"
        className="w-full space-y-3 rounded-xl border border-border bg-surface/70 p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 id="usage-heatmap-heading" className="font-semibold text-base">
            {t.heatmap}
          </h3>
          <Tabs
            value={metric}
            onValueChange={(value) => setMetric(value as Metric)}
            className="ml-auto"
          >
            <TabsList
              aria-label={t.metric}
              className="origin-top-right scale-[70%] touch-pan-y select-none p-0.5"
              onPointerDown={(event) => {
                if (event.button === 0)
                  swipe.current = { pointerId: event.pointerId, x: event.clientX, metric };
              }}
              onPointerCancel={() => {
                swipe.current = null;
              }}
              onPointerUp={(event) => {
                const start = swipe.current;
                swipe.current = null;
                if (!start || start.pointerId !== event.pointerId) return;
                const distance = event.clientX - start.x;
                if (Math.abs(distance) < 16) return;
                const next = metrics[metrics.indexOf(start.metric) + Math.sign(distance)];
                if (next) setMetric(next);
              }}
            >
              {metrics.map((choice) => (
                <TabsTrigger key={choice} value={choice} className="px-1.5 py-0.5 text-2xs">
                  {t.metrics[choice]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="flex gap-2">
          <div className="flex min-w-0 flex-1 gap-px">
            {months.map(({ key, name, weeks, days }) => (
              <div key={key} className="min-w-0" style={{ flex: `${weeks} 1 ${weeks - 1}px` }}>
                <h4 title={name} className="h-5 truncate text-2xs text-muted">
                  {name}
                </h4>
                <div
                  className="grid grid-flow-col grid-rows-7 gap-px"
                  style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}
                >
                  {days.map((day) => {
                    if (!day.totals)
                      return (
                        <span
                          key={day.key}
                          aria-hidden
                          className="aspect-square rounded-xs bg-hover"
                        />
                      );
                    const value = day.value ?? 0;
                    const level = value > 0 ? Math.ceil((value / maximum) * 4) : 0;
                    const detail = [
                      day.key,
                      `${t.metrics[metric]}：${day.range}`,
                      `${t.tokenMetric}：${formatNumber(day.value)}`,
                      `${t.requestMetric}：${formatNumber(day.totals.requests)}`,

                      `${t.rowCost}：${day.totals.cost}`,
                    ].join("\n");
                    return (
                      <span
                        key={day.key}
                        role="img"
                        aria-label={detail}
                        title={detail}
                        className={`aspect-square rounded-xs ${colors[level]}`}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted">
          {t.levels.map((label, index) => (
            <li key={label} className="flex items-center gap-1">
              <span aria-hidden className={`size-3 rounded-sm ${colors[index]}`} />
              {label}
            </li>
          ))}
        </ul>
      </section>
      <Section title={t.calls}>
        <div className="scroll-thin overflow-x-auto">
          <table aria-label={t.calls} className="w-full min-w-0 table-fixed text-left text-xs">
            <colgroup>
              {[18, 27, 11, 11, 11, 13, 9].map((width, index) => (
                <col
                  key={[t.time, t.model, t.input, t.output, t.total, t.rowCost, t.status][index]}
                  style={{ width: `${width}%` }}
                />
              ))}
            </colgroup>
            <thead className="text-muted">
              <tr>
                {[t.time, t.model, t.input, t.output, t.total, t.rowCost, t.status].map((label) => (
                  <th key={label} scope="col" className="break-words px-2 py-2 font-medium">
                    {label === t.time ? (
                      <div className="relative">
                        <button
                          type="button"
                          aria-expanded={calendarOpen}
                          onClick={() => {
                            if (!calendarOpen && !date) setDate(dayKey(today));
                            setCalendarOpen(!calendarOpen);
                          }}
                          className="flex items-center gap-1 text-left hover:text-accent"
                        >
                          {label}
                          <Icon name="chevron-down" size="sm" />
                        </button>
                        {calendarOpen && (
                          <div
                            role="dialog"
                            aria-label={t.date}
                            className="absolute left-0 top-full z-10 mt-2 rounded-lg border border-border bg-surface p-2 shadow-lg"
                            onKeyDown={(event) => {
                              if (event.key === "Escape") setCalendarOpen(false);
                            }}
                          >
                            <input
                              type="date"
                              aria-label={t.date}
                              className={fieldClass}
                              min={dayKey(start)}
                              max={dayKey(today)}
                              value={date || dayKey(today)}
                              onChange={(event) => {
                                setDate(event.target.value);
                                setCalendarOpen(false);
                              }}
                            />
                          </div>
                        )}
                      </div>
                    ) : (
                      label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border border-t border-border tabular-nums">
              {!filtered?.length && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted">
                    {periodCalls?.length ? t.noMatchingCalls : t.noData}
                  </td>
                </tr>
              )}
              {filtered?.map((call) => {
                const session = call.session;
                return (
                  <tr key={call.id}>
                    <td className="break-words px-2 py-2">
                      {session ? (
                        <button
                          type="button"
                          className="underline"
                          onClick={() => openSession(session)}
                        >
                          {dateTime.format(call.timestamp)}
                        </button>
                      ) : (
                        dateTime.format(call.timestamp)
                      )}
                    </td>
                    <td className="break-words px-2 py-2" title={call.model}>
                      {call.model}
                    </td>
                    <td className="break-words px-2 py-2">{formatNumber(call.input)}</td>
                    <td className="break-words px-2 py-2">{formatNumber(call.output)}</td>
                    <td className="break-words px-2 py-2">{formatNumber(call.total)}</td>
                    <td className="break-words px-2 py-2">
                      {call.cost ? formatCost(call.cost) : t.noData}
                    </td>
                    <td className="break-words px-2 py-2">{statuses[call.status]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {sessionError && (
          <p role="alert" className="p-3 text-sm text-danger">
            {t.sessionUnavailable}
          </p>
        )}
      </Section>
    </div>
  );
}
