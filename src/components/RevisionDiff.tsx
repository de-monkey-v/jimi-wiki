import {
  buildRevisionDiff,
  type DiffSegment,
  type RevisionDiffLimits,
  type RevisionSnapshotInput,
  type RevisionTextDiff,
} from "@/lib/revision-diff";

export interface RevisionDiffLabels {
  region: string;
  title: string;
  category: string;
  body: string;
  before: string;
  after: string;
  added: string;
  removed: string;
  unchanged: string;
  fallbackSize: string;
  fallbackComplexity: string;
  empty: string;
}

function Legend({ labels }: { labels: RevisionDiffLabels }) {
  return (
    <div role="group" className="flex flex-wrap items-center gap-2 text-[11px] font-medium" aria-label={labels.region}>
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-800">
        <span aria-hidden="true" className="font-mono">
          +
        </span>
        {labels.added}
      </span>
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-rose-800">
        <span aria-hidden="true" className="font-mono">
          −
        </span>
        {labels.removed}
      </span>
    </div>
  );
}

function Segment({ item, labels }: { item: DiffSegment; labels: RevisionDiffLabels }) {
  if (item.kind === "added") {
    return (
      <ins className="rounded-sm bg-emerald-100 px-0.5 text-emerald-950 decoration-emerald-700 decoration-2 underline-offset-2">
        <span className="sr-only">{labels.added}: </span>
        {item.value}
      </ins>
    );
  }
  if (item.kind === "removed") {
    return (
      <del className="rounded-sm bg-rose-100 px-0.5 text-rose-950 decoration-rose-700 decoration-2">
        <span className="sr-only">{labels.removed}: </span>
        {item.value}
      </del>
    );
  }
  return <span>{item.value}</span>;
}

function Snapshot({ label, value, empty }: { label: string; value: string; empty: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-stone-200 bg-white">
      <div className="border-b border-stone-200 px-3 py-1.5 text-xs font-semibold text-stone-500">{label}</div>
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
      >
        {value || <span className="font-sans italic text-stone-400">{empty}</span>}
      </pre>
    </div>
  );
}

function DiffField({
  title,
  value,
  labels,
}: {
  title: string;
  value: RevisionTextDiff;
  labels: RevisionDiffLabels;
}) {
  return (
    <section className="rounded-xl border border-stone-200 bg-stone-50/70 p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-stone-700">{title}</h3>
        {value.changed && value.mode === "diff" ? <Legend labels={labels} /> : null}
      </div>

      {value.mode === "snapshot" ? (
        <>
          <p role="note" className="mb-2 text-xs text-amber-800">
            {value.reason === "size" ? labels.fallbackSize : labels.fallbackComplexity}
          </p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Snapshot label={labels.before} value={value.before} empty={labels.empty} />
            <Snapshot label={labels.after} value={value.after} empty={labels.empty} />
          </div>
        </>
      ) : value.changed ? (
        <div
          tabIndex={0}
          aria-label={`${title} — ${labels.region}`}
          className="max-h-[38rem] overflow-auto rounded-lg border border-stone-200 bg-white p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
        >
          {value.segments.length > 0 ? (
            value.segments.map((item, index) => <Segment key={`${index}:${item.kind}`} item={item} labels={labels} />)
          ) : (
            <span className="font-sans italic text-stone-400">{labels.empty}</span>
          )}
        </div>
      ) : (
        <p className="text-sm text-stone-400">{labels.unchanged}</p>
      )}
    </section>
  );
}

/** title/category는 단어, body는 줄 기반+인접 변경 단어 세분화로 비교한다. */
export function RevisionDiff({
  before,
  after,
  labels,
  limits,
}: {
  before: RevisionSnapshotInput;
  after: RevisionSnapshotInput;
  labels: RevisionDiffLabels;
  /** 테스트·운영 튜닝용. 보통은 기본 안전 상한을 쓴다. */
  limits?: Partial<RevisionDiffLimits>;
}) {
  const result = buildRevisionDiff(before, after, limits);
  if (!result.changed) {
    return (
      <section aria-label={labels.region} className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-500">
        {labels.unchanged}
      </section>
    );
  }

  const fields = [
    { key: "title", title: labels.title, value: result.title },
    { key: "category", title: labels.category, value: result.category },
    { key: "body", title: labels.body, value: result.body },
  ].filter((field) => field.value.changed);

  return (
    <div role="region" aria-label={labels.region} className="space-y-3">
      {fields.map((field) => (
        <DiffField key={field.key} title={field.title} value={field.value} labels={labels} />
      ))}
    </div>
  );
}
