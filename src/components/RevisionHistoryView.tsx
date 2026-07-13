import Link from "next/link";
import { KnowledgeBadges, type KnowledgeBadgeLabels, type KnowledgeOrigin } from "@/components/KnowledgeBadges";
import { RevisionDiff, type RevisionDiffLabels } from "@/components/RevisionDiff";
import { RevisionRestoreControl } from "@/components/RevisionRestoreControl";
import type { ModelAccess, RevisionActor } from "@/generated/prisma/client";

export type HistoryRevision = {
  id: string;
  version: number;
  title: string;
  body: string;
  category: string | null;
  categoryLabel?: string;
  actor: RevisionActor;
  reason: string | null;
  createdAtLabel: string;
  modelAccess: ModelAccess;
  origin?: KnowledgeOrigin;
  kind?: string;
  archivedAt: Date | null;
  contentHash: string;
  sourceCount?: number;
};

export type RevisionHistoryLabels = {
  back: string;
  heading: string;
  subtitle: string;
  timeline: string;
  current: string;
  selected: string;
  compareHeading: string;
  initialSnapshot: string;
  actor: Record<RevisionActor, string>;
  reasonFallback: string;
  stateHeading: string;
  kind: string;
  modelAccess: string;
  documentState: string;
  archived: string;
  active: string;
  contentHash: string;
  sources: string;
  restore: string;
  restoring: string;
  restoreConfirm: string;
  restoreNotice: string;
  restoreFailed: string;
  empty: string;
  previousPage: string;
  nextPage: string;
};

const ACTOR_STYLE: Record<RevisionActor, { rail: string; dot: string; mark: string }> = {
  human: { rail: "border-l-stone-500", dot: "bg-stone-500", mark: "H" },
  agent: { rail: "border-l-indigo-500", dot: "bg-indigo-500", mark: "A" },
  system: { rail: "border-l-slate-500", dot: "bg-slate-500", mark: "S" },
  restore: { rail: "border-l-amber-500", dot: "bg-amber-500", mark: "R" },
};

export function RevisionHistoryView({
  backHref,
  revisions,
  currentVersion,
  selectedId,
  hrefForRevision,
  labels,
  diffLabels,
  badgeLabels,
  canRestore,
  restoreApiUrl,
  comparisonBefore,
  pagination,
}: {
  backHref: string;
  revisions: HistoryRevision[];
  currentVersion: number;
  selectedId?: string;
  hrefForRevision: (revisionId: string) => string;
  labels: RevisionHistoryLabels;
  diffLabels: RevisionDiffLabels;
  badgeLabels: KnowledgeBadgeLabels;
  canRestore: boolean;
  restoreApiUrl: string;
  comparisonBefore?: HistoryRevision;
  pagination?: { label: string; previousHref?: string; nextHref?: string };
}) {
  const selected = revisions.find((revision) => revision.id === selectedId) ?? revisions[0];
  const before = selected
    ? revisions.find((revision) => revision.version === selected.version - 1) ??
      (comparisonBefore?.version === selected.version - 1 ? comparisonBefore : undefined)
    : undefined;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <Link
        href={backHref}
        className="rounded-sm text-sm text-stone-500 hover:text-stone-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        ← {labels.back}
      </Link>
      <header className="mb-7 mt-4">
        <h1 className="text-2xl font-bold tracking-tight text-stone-900 sm:text-3xl">{labels.heading}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{labels.subtitle}</p>
      </header>

      {revisions.length === 0 || !selected ? (
        <section className="rounded-2xl border border-dashed border-stone-300 bg-white px-6 py-12 text-center text-sm text-stone-500">
          {labels.empty}
        </section>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <nav aria-label={labels.timeline} className="rounded-2xl border border-stone-200 bg-white p-2 shadow-sm">
            <ol className="max-h-[44rem] space-y-1 overflow-y-auto pr-1">
              {revisions.map((revision) => {
                const active = revision.id === selected.id;
                const style = ACTOR_STYLE[revision.actor];
                return (
                  <li key={revision.id}>
                    <Link
                      href={hrefForRevision(revision.id)}
                      aria-current={active ? "true" : undefined}
                      className={`group relative block rounded-xl border-l-4 px-3 py-3 ${style.rail} ${
                        active ? "bg-indigo-50 ring-1 ring-inset ring-indigo-200" : "hover:bg-stone-50"
                      } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-semibold tabular-nums text-stone-800">v{revision.version}</span>
                        {revision.version === currentVersion ? (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                            {labels.current}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 text-xs font-medium text-stone-600">
                        <span aria-hidden="true" className={`inline-grid h-4 w-4 place-items-center rounded-full text-[9px] text-white ${style.dot}`}>
                          {style.mark}
                        </span>
                        {labels.actor[revision.actor]}
                      </span>
                      <span className="mt-1 block font-mono text-[10px] tabular-nums text-stone-400">{revision.createdAtLabel}</span>
                    </Link>
                  </li>
                );
              })}
            </ol>
            {pagination && (pagination.previousHref || pagination.nextHref) ? (
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-stone-100 px-1 pt-2">
                {pagination.previousHref ? (
                  <Link href={pagination.previousHref} className="rounded px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                    ← {labels.previousPage}
                  </Link>
                ) : <span />}
                <span className="font-mono text-[10px] tabular-nums text-stone-400">{pagination.label}</span>
                {pagination.nextHref ? (
                  <Link href={pagination.nextHref} className="rounded px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                    {labels.nextPage} →
                  </Link>
                ) : <span />}
              </div>
            ) : null}
          </nav>

          <article aria-label={labels.selected} className="min-w-0 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-6">
            <div className={`border-l-4 pl-4 ${ACTOR_STYLE[selected.actor].rail}`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-bold tabular-nums text-stone-900">v{selected.version}</span>
                    <span className="text-xs font-semibold text-stone-600">{labels.actor[selected.actor]}</span>
                    <span className="font-mono text-xs tabular-nums text-stone-400">{selected.createdAtLabel}</span>
                  </div>
                  <p className="mt-1 break-words text-sm text-stone-600">{selected.reason ?? labels.reasonFallback}</p>
                </div>
                <KnowledgeBadges
                  origin={selected.origin}
                  modelAccess={selected.modelAccess}
                  labels={badgeLabels}
                  className="shrink-0"
                />
              </div>
            </div>

            <section className="mt-5">
              <h2 className="mb-3 text-base font-semibold text-stone-900">
                {before ? `${labels.compareHeading}: v${before.version} → v${selected.version}` : labels.initialSnapshot}
              </h2>
              <RevisionDiff
                before={{ title: before?.title ?? "", body: before?.body ?? "", category: before?.category ?? null }}
                after={{ title: selected.title, body: selected.body, category: selected.category }}
                labels={{ ...diffLabels, category: selected.categoryLabel ?? diffLabels.category }}
              />
            </section>

            <section className="mt-5 border-t border-stone-100 pt-5">
              <h2 className="text-sm font-semibold text-stone-800">{labels.stateHeading}</h2>
              <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2 xl:grid-cols-3">
                {selected.kind ? (
                  <div className="rounded-lg bg-stone-50 p-3">
                    <dt className="text-stone-400">{labels.kind}</dt>
                    <dd className="mt-1 font-mono font-medium text-stone-700">{selected.kind}</dd>
                  </div>
                ) : null}
                <div className="rounded-lg bg-stone-50 p-3">
                  <dt className="text-stone-400">{labels.modelAccess}</dt>
                  <dd className="mt-1 font-mono font-medium text-stone-700">{selected.modelAccess}</dd>
                </div>
                <div className="rounded-lg bg-stone-50 p-3">
                  <dt className="text-stone-400">{labels.documentState}</dt>
                  <dd className="mt-1 font-medium text-stone-700">{selected.archivedAt ? labels.archived : labels.active}</dd>
                </div>
                {selected.sourceCount !== undefined ? (
                  <div className="rounded-lg bg-stone-50 p-3">
                    <dt className="text-stone-400">{labels.sources}</dt>
                    <dd className="mt-1 font-mono font-medium tabular-nums text-stone-700">{selected.sourceCount}</dd>
                  </div>
                ) : null}
                <div className="rounded-lg bg-stone-50 p-3 sm:col-span-2">
                  <dt className="text-stone-400">{labels.contentHash}</dt>
                  <dd className="mt-1 truncate font-mono text-[10px] text-stone-600" title={selected.contentHash}>{selected.contentHash}</dd>
                </div>
              </dl>
            </section>

            {canRestore && selected.version !== currentVersion ? (
              <section className="mt-5 rounded-xl border border-amber-200 bg-amber-50/70 p-4">
                <p className="text-xs leading-5 text-amber-900">{labels.restoreNotice}</p>
                <div className="mt-3">
                  <RevisionRestoreControl
                    apiUrl={restoreApiUrl}
                    revisionId={selected.id}
                    expectedVersion={currentVersion}
                    idle={labels.restore}
                    pendingLabel={labels.restoring}
                    confirmMessage={labels.restoreConfirm}
                    failedLabel={labels.restoreFailed}
                  />
                </div>
              </section>
            ) : null}
          </article>
        </div>
      )}
    </main>
  );
}
