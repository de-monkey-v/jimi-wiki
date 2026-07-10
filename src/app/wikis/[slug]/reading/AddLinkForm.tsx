"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { saveLinkAction } from "@/app/wikis/actions";

/** 읽을거리에 URL 담기. 저장 시 서버가 제목·설명을 자동 추출(LLM 없음). */
export function AddLinkForm({ wikiSlug }: { wikiSlug: string }) {
  const t = useTranslations("WikisSlugReadingPage");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const u = url.trim();
          if (!u) return;
          setErr(null);
          start(async () => {
            try {
              await saveLinkAction(wikiSlug, u);
              setUrl("");
              router.refresh();
            } catch (e) {
              setErr((e as Error).message);
            }
          });
        }}
        className="flex gap-2"
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          type="url"
          inputMode="url"
          placeholder={t("addPlaceholder")}
          className="min-w-0 flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-md bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:opacity-50"
        >
          {pending ? t("adding") : t("addButton")}
        </button>
      </form>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  );
}
