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
          aria-label={t("addPlaceholder")}
          placeholder={t("addPlaceholder")}
          className="field-control min-w-0 flex-1 text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="btn-primary shrink-0 text-sm"
        >
          {pending ? t("adding") : t("addButton")}
        </button>
      </form>
      {err && <p role="alert" aria-live="polite" className="mt-2 text-xs text-rose-600">{err}</p>}
    </div>
  );
}
