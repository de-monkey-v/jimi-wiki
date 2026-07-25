"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

type State = "idle" | "pending" | "queued" | "error";

export function CurateSourceButton({
  wikiSlug,
  sourceSlug,
}: {
  wikiSlug: string;
  sourceSlug: string;
}) {
  const t = useTranslations("CurateSourceButton");
  const [state, setState] = useState<State>("idle");

  const curate = async () => {
    setState("pending");
    try {
      const response = await fetch(
        `/api/wikis/${encodeURIComponent(wikiSlug)}/sources/${encodeURIComponent(sourceSlug)}/curate`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error("curate_failed");
      setState("queued");
    } catch {
      setState("error");
    }
  };

  if (state === "queued") {
    return (
      <span role="status" className="inline-flex flex-wrap items-center gap-2 text-sm font-medium text-emerald-700">
        {t("queued")}
        <Link href={`/wikis/${encodeURIComponent(wikiSlug)}/builds`} className="rounded-sm text-indigo-700 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
          {t("viewBuilds")}
        </Link>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={state === "pending"}
        onClick={() => void curate()}
        className="btn-primary text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state === "pending" ? t("pending") : t("action")}
      </button>
      {state === "error" ? <span role="alert" className="text-xs font-medium text-rose-700">{t("error")}</span> : null}
    </span>
  );
}
