"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { EmptyState } from "@/components/EmptyState";
import { DocModal, type EvidenceDoc } from "./DocModal";
import { remarkCitations } from "./remarkCitations";

// 무거운 마크다운 렌더러(streamdown)는 초기 채팅 청크에서 분리 → 첫 답변 렌더 시 로드(초기 로딩 단축).
const Streamdown = dynamic(() => import("streamdown").then((m) => m.Streamdown), { ssr: false });
import type { WikiUIMessage, ChatSource } from "@/app/api/wikis/[id]/chat/types";

function textOf(m: WikiUIMessage): string {
  return (m.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
}

function sourcesOf(m: WikiUIMessage): ChatSource[] {
  const part = (m.parts ?? []).find((p) => p.type === "data-sources") as
    | { type: "data-sources"; data: ChatSource[] }
    | undefined;
  return part?.data ?? [];
}

// href(#cite-N) 또는 자식 텍스트(숫자)에서 인용 번호 추출 — href가 sanitize로 변형돼도 텍스트 폴백으로 견고
function citeNumber(href: string | undefined, text: string): number | null {
  const raw = href?.match(/^#cite-(\d+)$/)?.[1] ?? (/^\d+$/.test(text) ? text : null);
  return raw ? Number(raw) : null;
}

// 답변 원문에서 실제 인용된 [번호]들을 추출 — "[1]", "[1, 2]" 형태 모두 처리
function citedNumbers(text: string): Set<number> {
  const cited = new Set<number>();
  for (const m of text.matchAll(/\[([\d,\s]+)\]/g)) {
    for (const part of m[1].split(",")) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n > 0) cited.add(n);
    }
  }
  return cited;
}

// 근거를 인용/미인용으로 분리. 인용이 하나도 파싱되지 않으면(모델이 인용 생략) 전부 인용으로 취급.
function splitByCited(sources: ChatSource[], cited: Set<number>): { cited: ChatSource[]; rest: ChatSource[] } {
  if (cited.size === 0) return { cited: sources, rest: [] };
  const c: ChatSource[] = [];
  const r: ChatSource[] = [];
  for (const s of sources) (cited.has(s.n) ? c : r).push(s);
  if (c.length === 0) return { cited: sources, rest: [] };
  return { cited: c, rest: r };
}

function MarkdownMessage({
  content,
  sources,
  onOpenCite,
}: {
  content: string;
  sources: ChatSource[];
  onOpenCite: (n: number) => void;
}) {
  const linkable = new Set(sources.map((s) => s.n));
  // streamdown은 기본으로 rehype-sanitize + harden(위험 URL/프로토콜 차단) 내장 → 별도 prefix prop 불필요.
  return (
    <div className="text-sm leading-relaxed">
      <Streamdown
        parseIncompleteMarkdown
        remarkPlugins={[remarkCitations]}
        components={{
          a: ({ href, children, ...rest }) => {
            const text = Array.isArray(children) ? children.join("") : String(children ?? "");
            const n = citeNumber(typeof href === "string" ? href : undefined, text);
            if (n !== null) {
              const ok = linkable.has(n);
              return (
                <button
                  type="button"
                  disabled={!ok}
                  onClick={() => onOpenCite(n)}
                  aria-label={`근거 [${n}] 열기`}
                  className="mx-px inline-flex items-center rounded bg-blue-50 px-1 align-baseline text-[11px] font-medium text-blue-700 hover:bg-blue-100 disabled:bg-gray-100 disabled:text-gray-400"
                >
                  {n}
                </button>
              );
            }
            return (
              <a href={typeof href === "string" ? href : undefined} target="_blank" rel="noopener noreferrer" {...rest}>
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </Streamdown>
    </div>
  );
}

// 모바일 폴백: 답변 아래 인라인 칩(데스크톱은 우측 패널이 대신). 인용된 근거만. 클릭 시 모달.
function SourceCards({ sources, cited, onOpen }: { sources: ChatSource[]; cited: Set<number>; onOpen: (d: EvidenceDoc) => void }) {
  const { cited: citedSources } = splitByCited(sources, cited);
  if (citedSources.length === 0) return null;
  return (
    <div className="mt-3 pt-2 border-t border-gray-200 flex flex-wrap gap-2 lg:hidden">
      {citedSources.map((s) => (
        <button
          key={s.n}
          onClick={() => onOpen({ kind: s.kind, slug: s.slug, title: s.title, heading: s.heading })}
          className="text-left text-xs bg-white border rounded-md px-2 py-1 hover:border-blue-400"
        >
          <span className="text-gray-400">[{s.n}]</span> {s.title}
          {s.heading ? <span className="text-gray-400"> › {s.heading}</span> : null}
        </button>
      ))}
    </div>
  );
}

function EvidenceItem({ s, onOpen }: { s: ChatSource; onOpen: (d: EvidenceDoc) => void }) {
  return (
    <li>
      <button
        onClick={() => onOpen({ kind: s.kind, slug: s.slug, title: s.title, heading: s.heading })}
        className="w-full rounded-md border border-stone-200 px-2.5 py-1.5 text-left text-xs hover:border-blue-400 hover:bg-stone-50"
      >
        <span className="text-stone-400">[{s.n}]</span>{" "}
        <span className="font-medium text-stone-700">{s.title}</span>
        {s.kind === "source" && <span className="ml-1 rounded bg-stone-100 px-1 text-[10px] text-stone-500">원문</span>}
        {s.heading ? <span className="block pl-4 text-stone-400">{s.heading}</span> : null}
      </button>
    </li>
  );
}

// 데스크톱 우측 근거 패널: 답변에 실제 인용된 근거를 우선 표시, 미인용 검색 결과는 접어둔다. 클릭 시 모달.
function EvidencePanel({ sources, cited, onOpen }: { sources: ChatSource[]; cited: Set<number>; onOpen: (d: EvidenceDoc) => void }) {
  const { cited: citedSources, rest } = splitByCited(sources, cited);
  return (
    <aside className="hidden lg:block w-72 shrink-0">
      <div className="rounded-lg border bg-white p-3">
        <h2 className="mb-2 text-sm font-semibold text-stone-600">근거 자료</h2>
        {sources.length === 0 ? (
          <EmptyState
            asset="chat-ready"
            title="근거 대기 중"
            body="질문하면 답변의 근거 문서가 여기 표시됩니다."
            compact
          />
        ) : (
          <>
            <ul className="space-y-1.5">
              {citedSources.map((s) => (
                <EvidenceItem key={s.n} s={s} onOpen={onOpen} />
              ))}
            </ul>
            {rest.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-stone-400 hover:text-stone-600">
                  함께 검색된 문서 {rest.length}건 (답변에 인용되지 않음)
                </summary>
                <ul className="mt-1.5 space-y-1.5">
                  {rest.map((s) => (
                    <EvidenceItem key={s.n} s={s} onOpen={onOpen} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

export function WikiChat({ slug }: { slug: string }) {
  const { messages, sendMessage, status, stop, regenerate, error, clearError } = useChat<WikiUIMessage>({
    transport: new DefaultChatTransport({ api: `/api/wikis/${encodeURIComponent(slug)}/chat` }),
  });
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";
  const endRef = useRef<HTMLDivElement>(null);
  const [activeDoc, setActiveDoc] = useState<EvidenceDoc | null>(null);
  // 우측 패널 기본값: 마지막 assistant 답변의 근거 문서(최근 답변 기준) + 실제 인용된 번호
  const lastAssistant = [...messages].reverse().find((m) => m.role !== "user");
  const latestSources = lastAssistant ? sourcesOf(lastAssistant) : [];
  const latestCited = lastAssistant ? citedNumbers(textOf(lastAssistant)) : new Set<number>();

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function submit() {
    const q = input.trim();
    if (!q || busy) return;
    sendMessage({ text: q });
    setInput("");
  }

  return (
    <div className="flex gap-4">
      <div className="flex flex-col h-[68vh] min-w-0 flex-1 border rounded-lg overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-white">
        {messages.length === 0 && (
          <div className="flex min-h-full items-center justify-center">
            <EmptyState
              asset="chat-ready"
              title="이 위키에 대해 물어보세요"
              body="저장된 내용을 근거로 답하고, 근거 문서는 답변과 함께 표시됩니다."
            />
          </div>
        )}
        {messages.map((m) => {
          const text = textOf(m);
          const isUser = m.role === "user";
          const sources = isUser ? [] : sourcesOf(m);
          return (
            <div key={m.id} className={isUser ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  isUser
                    ? "bg-stone-900 text-white rounded-2xl rounded-br-sm px-4 py-2 max-w-[80%] whitespace-pre-wrap text-sm"
                    : "bg-gray-50 text-gray-900 rounded-2xl rounded-bl-sm px-4 py-3 max-w-[85%] border"
                }
              >
                {isUser ? (
                  text
                ) : text.trim() ? (
                  <MarkdownMessage
                    content={text}
                    sources={sources}
                    onOpenCite={(n) => {
                      const s = sources.find((x) => x.n === n);
                      if (s) setActiveDoc({ kind: s.kind, slug: s.slug, title: s.title, heading: s.heading });
                    }}
                  />
                ) : busy ? (
                  <span className="text-gray-400 text-sm">검색 중…</span>
                ) : null}

                {!isUser && <SourceCards sources={sources} cited={citedNumbers(text)} onOpen={setActiveDoc} />}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {status === "error" && error && (
        <div role="alert" className="border-t bg-red-50 px-4 py-2 text-sm text-red-700 flex items-center gap-3">
          <span className="flex-1">오류: {error.message}</span>
          <button onClick={() => regenerate()} className="border rounded px-2 py-0.5 hover:bg-red-100">재시도</button>
          <button onClick={() => clearError()} className="hover:underline">닫기</button>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-end gap-2 border-t p-3 bg-gray-50"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="위키에 질문…  (Enter 전송 · Shift+Enter 줄바꿈)"
          className="flex-1 resize-none border rounded-lg px-3 py-2 max-h-32"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => stop()}
            className="bg-gray-700 text-white rounded-lg px-5 py-2 shrink-0"
          >
            중지
          </button>
        ) : (
          <button type="submit" className="bg-stone-900 text-white rounded-lg px-5 py-2 shrink-0">
            보내기
          </button>
        )}
      </form>
      </div>
      <EvidencePanel sources={latestSources} cited={latestCited} onOpen={setActiveDoc} />
      <DocModal doc={activeDoc} wikiSlug={slug} onClose={() => setActiveDoc(null)} />
    </div>
  );
}
