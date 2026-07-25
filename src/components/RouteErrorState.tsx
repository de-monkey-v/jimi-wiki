"use client";

export function RouteErrorState({
  title,
  body,
  retry,
  reset,
}: {
  title: string;
  body: string;
  retry: string;
  reset: () => void;
}) {
  return (
    <main className="mx-auto standard-measure px-4 py-16 sm:px-6">
      <section role="alert" className="mx-auto max-w-3xl rounded-2xl border border-rose-200 bg-white p-6 shadow-sm">
        <div aria-hidden="true" className="mb-3 font-mono text-lg font-semibold text-rose-600">!</div>
        <h1 className="text-xl font-semibold tracking-tight text-stone-900">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-stone-600">{body}</p>
        <button
          type="button"
          onClick={reset}
          className="mt-5 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
        >
          {retry}
        </button>
      </section>
    </main>
  );
}
