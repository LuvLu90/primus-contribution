"use client";

import { LogoAssemble } from "@/components/brand/logo";
import { strings } from "@/lib/strings";
import { UpdateSettings } from "./update-settings";

const t = strings.settings.about;

export function AboutSettings() {
  return (
    <div className="flex min-w-0 flex-col gap-7">
      <div className="flex flex-col items-center gap-4 pt-4 pb-1">
        <LogoAssemble size={88} className="text-fg" />
        <h3 className="text-2xl font-semibold tracking-tight">{t.productName}</h3>
      </div>
      <p className="text-base leading-relaxed text-muted">
        <strong className="font-semibold text-fg">{t.introduction}</strong>
        {t.description}
      </p>
      <UpdateSettings compact />
    </div>
  );
}
