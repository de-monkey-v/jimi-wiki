"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  archivePageAction,
  archiveSourceAction,
  changePagePolicyAction,
  changeSourcePolicyAction,
  promotePageToSourceAction,
  restorePageAction,
  restoreSourceAction,
  trashPageAction,
  trashSourceAction,
  type KnowledgeControlState,
} from "@/app/wikis/[slug]/knowledge-controls-actions";
import type { ModelAccess } from "@/generated/prisma/client";

const INITIAL_STATE: KnowledgeControlState = { status: "idle" };

function Feedback({ state }: { state: KnowledgeControlState }) {
  const t = useTranslations("KnowledgeControls");
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return <p role="status" className="text-xs font-medium text-emerald-700">{t("saved")}</p>;
  }
  return (
    <p role="alert" className="text-xs font-medium text-rose-700">
      {t(`error.${state.code ?? "failed"}`)}
    </p>
  );
}

function HiddenIdentity({
  wikiSlug,
  resourceSlug,
  currentVersion,
}: {
  wikiSlug: string;
  resourceSlug: string;
  currentVersion: number;
}) {
  return (
    <>
      <input type="hidden" name="wikiSlug" value={wikiSlug} />
      <input type="hidden" name="resourceSlug" value={resourceSlug} />
      <input type="hidden" name="expectedVersion" value={currentVersion} />
    </>
  );
}

export function KnowledgeControls({
  resourceType,
  wikiSlug,
  resourceSlug,
  currentVersion,
  modelAccess,
  archived,
  personal = false,
  canLifecycle = true,
  canPromote = false,
  sourceImpact,
}: {
  resourceType: "page" | "source";
  wikiSlug: string;
  resourceSlug: string;
  currentVersion: number;
  modelAccess: ModelAccess;
  archived: boolean;
  personal?: boolean;
  owner: boolean;
  canLifecycle?: boolean;
  canPromote?: boolean;
  sourceImpact?: { notes: number; derived: number };
}) {
  const t = useTranslations("KnowledgeControls");
  const router = useRouter();
  const [selection, setSelection] = useState<{ base: ModelAccess; value: ModelAccess }>({
    base: modelAccess,
    value: personal ? "internalOnly" : modelAccess,
  });
  const policyServerAction = resourceType === "page" ? changePagePolicyAction : changeSourcePolicyAction;
  const archiveServerAction = resourceType === "page" ? archivePageAction : archiveSourceAction;
  const restoreServerAction = resourceType === "page" ? restorePageAction : restoreSourceAction;
  const trashServerAction = resourceType === "page" ? trashPageAction : trashSourceAction;
  const [policyState, policyAction, policyPending] = useActionState(policyServerAction, INITIAL_STATE);
  const [lifecycleState, archiveAction, archivePending] = useActionState(archiveServerAction, INITIAL_STATE);
  const [restoreState, restoreAction, restorePending] = useActionState(restoreServerAction, INITIAL_STATE);
  const [trashState, trashAction, trashPending] = useActionState(trashServerAction, INITIAL_STATE);
  const [promotionState, promotionAction, promotionPending] = useActionState(
    promotePageToSourceAction,
    INITIAL_STATE,
  );

  useEffect(() => {
    if ([policyState, lifecycleState, restoreState, promotionState].some((state) => state.status === "success")) {
      router.refresh();
    }
  }, [policyState, lifecycleState, restoreState, promotionState, router]);

  const requested = personal
    ? "internalOnly"
    : selection.base === modelAccess
      ? selection.value
      : modelAccess;
  const enablingExternal = modelAccess === "internalOnly" && requested === "external";
  const lifecyclePending = archivePending || restorePending;

  return (
    <section aria-labelledby={`${resourceType}-controls-heading`} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
      {/* 자주 쓰는 제어가 아니라 기본 접힘 — 네이티브 details라 JS 상태 없이 키보드·스크린리더 동작 확보 */}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 [&::-webkit-details-marker]:hidden">
          <div>
            <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-600">{t("eyebrow")}</div>
            <h2 id={`${resourceType}-controls-heading`} className="mt-1 text-base font-semibold text-stone-900">{t("title")}</h2>
          </div>
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4 shrink-0 text-stone-400 transition-transform duration-150 group-open:rotate-180"
          >
            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.39a.75.75 0 0 1-1.08 0L5.21 8.27a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" />
          </svg>
        </summary>

      <form action={policyAction} className="mt-4 space-y-3">
        <HiddenIdentity wikiSlug={wikiSlug} resourceSlug={resourceSlug} currentVersion={currentVersion} />
        {personal ? <input type="hidden" name="modelAccess" value="internalOnly" /> : null}
        <label className="block text-sm font-medium text-stone-700">
          {t("policyLabel")}
          <select
            name="modelAccess"
            value={requested}
            disabled={personal || policyPending}
            onChange={(event) => setSelection({ base: modelAccess, value: event.target.value as ModelAccess })}
            className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:bg-stone-100 disabled:text-stone-500"
          >
            <option value="external">{t("external")}</option>
            <option value="internalOnly">{t("internalOnly")}</option>
          </select>
        </label>
        {personal ? <p className="text-xs leading-5 text-amber-800">{t("personalForced")}</p> : null}
        {enablingExternal ? (
          <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
            <input required name="confirmExternalAccess" type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600" />
            <span>{t("externalConfirm")}</span>
          </label>
        ) : null}
        <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-600">
          <span aria-hidden="true" className="mr-1 text-amber-700">◆</span>
          {t("dispatchWarning")}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={personal || policyPending || requested === modelAccess}
            className="rounded-lg bg-stone-900 px-3 py-2 text-sm font-semibold text-white hover:bg-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {policyPending ? t("saving") : t("savePolicy")}
          </button>
          <Feedback state={policyState} />
        </div>
      </form>

      {resourceType === "page" && canPromote ? (
        <div className="mt-5 border-t border-indigo-100 pt-5">
          <h3 className="text-sm font-semibold text-stone-800">{t("promotionHeading")}</h3>
          <p className="mt-1 text-xs leading-5 text-stone-600">
            {t(modelAccess === "external" ? "promotionExternalDescription" : "promotionInternalDescription")}
          </p>
          <form
            action={promotionAction}
            className="mt-3 flex flex-wrap items-center gap-3"
            onSubmit={(event) => {
              const key = modelAccess === "external" ? "promotionExternalConfirm" : "promotionInternalConfirm";
              if (!window.confirm(t(key))) event.preventDefault();
            }}
          >
            <HiddenIdentity wikiSlug={wikiSlug} resourceSlug={resourceSlug} currentVersion={currentVersion} />
            <button
              type="submit"
              disabled={promotionPending}
              className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm font-semibold text-indigo-800 hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {promotionPending ? t("promoting") : t("promote")}
            </button>
            {promotionState.status === "success" && promotionState.sourceSlug ? (
              <p role="status" className="text-xs font-medium text-emerald-700">
                {t("promoted")} {" "}
                <Link
                  href={`/wikis/${encodeURIComponent(wikiSlug)}/sources/${encodeURIComponent(promotionState.sourceSlug)}`}
                  className="rounded-sm text-indigo-700 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  {t("viewPromotedSource")}
                </Link>
              </p>
            ) : (
              <Feedback state={promotionState} />
            )}
          </form>
        </div>
      ) : null}

      {canLifecycle ? (
        <div className="mt-5 border-t border-stone-100 pt-5">
          <h3 className="text-sm font-semibold text-stone-800">{t("lifecycleHeading")}</h3>
          {sourceImpact ? (
            <p className="mt-1 text-xs leading-5 text-stone-500">
              {t("sourceArchiveImpact", { notes: sourceImpact.notes, derived: sourceImpact.derived })}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {archived ? (
              <form
                action={restoreAction}
                onSubmit={(event) => {
                  if (!window.confirm(t("restoreConfirm"))) event.preventDefault();
                }}
              >
                <HiddenIdentity wikiSlug={wikiSlug} resourceSlug={resourceSlug} currentVersion={currentVersion} />
                <button
                  type="submit"
                  disabled={lifecyclePending}
                  className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  {restorePending ? t("restoring") : t("restore")}
                </button>
              </form>
            ) : (
              <form
                action={archiveAction}
                onSubmit={(event) => {
                  if (!window.confirm(t("archiveConfirm"))) event.preventDefault();
                }}
              >
                <HiddenIdentity wikiSlug={wikiSlug} resourceSlug={resourceSlug} currentVersion={currentVersion} />
                <button
                  type="submit"
                  disabled={lifecyclePending}
                  className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  {archivePending ? t("archiving") : t("archive")}
                </button>
              </form>
            )}
            <Feedback state={archived ? restoreState : lifecycleState} />
          </div>
          <form
            action={trashAction}
            className="mt-4 border-t border-rose-100 pt-4"
            onSubmit={(event) => {
              if (!window.confirm(t("trashConfirm"))) event.preventDefault();
            }}
          >
            <HiddenIdentity wikiSlug={wikiSlug} resourceSlug={resourceSlug} currentVersion={currentVersion} />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={trashPending}
                className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2 disabled:opacity-50"
              >
                {trashPending ? t("trashing") : t("trash")}
              </button>
              <Feedback state={trashState} />
            </div>
          </form>
        </div>
      ) : null}
      </details>
    </section>
  );
}
