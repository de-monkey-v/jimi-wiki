export function RouteLoadingState({ label }: { label: string }) {
  return (
    <main aria-busy="true" aria-label={label} className="mx-auto standard-measure px-4 py-10 sm:px-6">
      <span className="sr-only">{label}</span>
      <div className="animate-pulse space-y-5 motion-reduce:animate-none">
        <div className="h-4 w-32 rounded bg-stone-200" />
        <div className="h-9 w-64 max-w-full rounded bg-stone-200" />
        <div className="grid gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
          <div className="h-72 rounded-2xl border border-stone-200 bg-white" />
          <div className="h-96 rounded-2xl border border-stone-200 bg-white" />
        </div>
      </div>
    </main>
  );
}
