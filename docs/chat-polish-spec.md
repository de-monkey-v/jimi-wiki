# 채팅 "완성형" 구현 스펙 (chat-polish)

3개 리서치(AI SDK v6 출처 스트리밍 · 스트리밍 마크다운 · 코드베이스/UX 정찰)를 통합한 단일 구현 스펙.
대상 저장소: `jimi-wiki-app`. 목표: WikiChat 채팅을 마크다운 스트리밍 렌더 + 클릭 가능한 출처 카드 + stop/자동스크롤/에러재시도까지 갖춘 완성형으로 만든다.

## 0. 현재 환경 (실측 — package.json)

- `ai@^6.0.218`, `@ai-sdk/react@^3.0.220`, `@ai-sdk/google@^3.0.88` → **AI SDK v6 GA 표면 그대로 적용 가능.**
- `react@19.2.4`, `react-dom@19.2.4`, `next@16.2.10`, `tailwindcss@^4`, `remark-gfm@^4.0.1`.
- 채팅 라우트: `src/app/api/wikis/[id]/chat/route.ts` (현재 출처를 프롬프트에만 쓰고 클라로 안 보냄).
- 채팅 UI: `src/app/wikis/[slug]/chat/WikiChat.tsx` (순수 텍스트, stop/스크롤/에러/출처카드 전무).
- 출처 링크 대상 라우트 확정: `src/app/wikis/[slug]/[pageSlug]/page.tsx` → URL `/wikis/<slug>/<pageSlug>`.
- `SearchHit` (src/lib/search.ts L145-154): `{ id, refType, refId, heading, snippet, score, pageSlug?, pageTitle? }`. `refType==="source"`면 `pageSlug`/`pageTitle` undefined.
- 저장 서버액션 `saveAnswerAction(slug, question, answer)` (editor 이상) — 유지.

---

## 1. 핵심 결정 (확정)

| 항목 | 결정 | 근거 |
|---|---|---|
| 출처 스트리밍 방식 | **커스텀 data part** (`createUIMessageStream` + `writer.write({type:'data-sources'})`) | 타입 세이프, `message.parts`에 영속·재렌더, 구조화 리스트에 최적. `messageMetadata`(라이프사이클 스칼라)·네이티브 `source` 파트(url/document 고정)는 부적합 |
| 마크다운 렌더 | **streamdown@2.5.0** | 스트리밍 중 불완전 토큰(`**bold`, 미완 테이블) 자동 보정(remend 내장). GFM/sanitize/harden 기본 탑재. react19.2/next16 호환 |
| XSS | streamdown 기본 sanitize+harden + **URL prefix 하드닝 필수** | LLM 출력 prompt injection 대비 |
| input 잠금 | 스트리밍 중에도 **활성 유지**, 전송 버튼만 stop으로 토글 | UX 결함 제거 |
| 입력 | `<input>` → `<textarea>`, Enter=전송 / Shift+Enter=개행 | 완성형 관례 |

---

## 2. 설치 패키지 (정확한 버전)

```bash
npm i streamdown@2.5.0
```

- streamdown이 `remark-gfm@4`, `rehype-sanitize@6`, `rehype-harden@1.1.8`, `remend@1.3.0`, `marked`, `mermaid`, `unified`, `rehype-raw`를 **번들 내장**하므로 추가 설치 불필요.
- peer: `react ^18||^19`, `react-dom ^18||^19` → 현재 19.2.4 충족.
- Quartz/기타 코드는 건드리지 않음. `ai`/`@ai-sdk/*`는 이미 v6라 버전 변경 없음.

### Tailwind v4 `@source` 등록 (필수)

`src/app/globals.css` 최상단(`@import "tailwindcss";` 아래)에 추가 — streamdown dist의 클래스를 Tailwind가 스캔하도록:

```css
@source "../../node_modules/streamdown/dist/index.js";
```

> 경로는 `globals.css` 기준 상대경로. `src/app/globals.css`이면 저장소 루트 `node_modules`까지 `../../node_modules/...`. 실제 설치 후 `ls node_modules/streamdown/dist/`로 진입 파일명 확인해 맞춘다. (`.wiki-content` 프로즈 스타일이 이미 있으므로 아래처럼 `.wiki-content`로 래핑하면 대부분의 타이포는 기존 CSS가 커버.)

---

## 3. 공통 타입 — 신규 `src/app/api/wikis/[id]/chat/types.ts`

```ts
import type { UIMessage } from "ai";

export type ChatSource = {
  n: number;                 // 프롬프트의 [번호] 인용과 1:1 일치 (i+1)
  pageSlug?: string;         // page 히트만 존재. source 히트면 undefined → 비링크
  pageTitle: string;         // pageTitle ?? refType
  heading?: string;
};

export type WikiChatMetadata = { createdAt?: number };

// data part 맵: key K -> `data-K` 파트, part.data 타입 = 값
export type WikiChatDataParts = { sources: ChatSource[] }; // => type:'data-sources', data: ChatSource[]

export type WikiUIMessage = UIMessage<WikiChatMetadata, WikiChatDataParts>;
```

---

## 4. 서버 라우트 — `src/app/api/wikis/[id]/chat/route.ts`

**변경 최소화.** 게이트(401/404)·검색·프롬프트·모델은 그대로 두고, `toUIMessageStreamResponse()` 반환부만 `createUIMessageStream` + data part로 교체한다.

```ts
import { google } from "@ai-sdk/google";
import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { getCurrentUser } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { hybridSearch } from "@/lib/search";
import type { WikiUIMessage, ChatSource } from "./types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function textOf(m: UIMessage): string {
  return (m.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join(" ");
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const wiki = await getWikiForUser(user.id, decodeURIComponent(id));
  if (!wiki) return new Response("not_found", { status: 404 });

  const { messages }: { messages: WikiUIMessage[] } = await req.json();
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const q = lastUser ? textOf(lastUser) : "";

  const hits = q ? await hybridSearch(wiki.id, q, 8) : [];
  const context = hits
    .map((h, i) => `[${i + 1}] ${h.pageTitle ?? h.refType}${h.heading ? " › " + h.heading : ""}\n${h.snippet}`)
    .join("\n\n");

  // 출처 카드용: n은 프롬프트 [i+1] 인용번호와 정확히 일치
  const sources: ChatSource[] = hits.map((h, i) => ({
    n: i + 1,
    pageSlug: h.refType === "page" ? h.pageSlug : undefined, // source 히트는 비링크
    pageTitle: h.pageTitle ?? h.refType,
    heading: h.heading || undefined,
  }));

  const system =
    `너는 이 위키("${wiki.title}")의 지식으로만 답하는 조수다. 아래 '검색 결과'에 담긴 근거만 사용해 한국어로 답하라.\n` +
    `- 근거에 없는 내용은 추측하지 말고 "위키에 관련 내용이 없다"고 말하라.\n` +
    `- 사용한 근거는 문장 끝에 [번호]로 인용하라.\n` +
    `- 답변 끝에 "참고" 제목으로 사용한 페이지 제목들을 목록으로 적어라.\n\n` +
    `검색 결과:\n${context || "(관련 결과 없음)"}`;

  const stream = createUIMessageStream<WikiUIMessage>({
    originalMessages: messages,
    execute: ({ writer }) => {
      // 영속 data part: id 고정 → reconcile, message.parts에 남아 재렌더됨
      if (sources.length > 0) {
        writer.write({ type: "data-sources", id: "sources", data: sources });
      }
      const result = streamText({
        model: google("gemini-2.5-flash"),
        system,
        messages: convertToModelMessages(messages) as never, // convertToModelMessages는 v6에서 sync/async 표면 모두 지원 — 아래 주 참고
      });
      writer.merge(result.toUIMessageStream());
    },
    onError: (err) => (err instanceof Error ? err.message : "stream error"),
  });

  return createUIMessageStreamResponse({ stream });
}
```

**주의 — `convertToModelMessages`:** 현재 코드는 `await convertToModelMessages(messages)`를 이미 쓰고 있으므로(리서치1의 v6 async 지침과 일치), 위 `execute` 내부에서도 **await 형태로 유지**하는 것이 안전하다. `execute`는 async 콜백을 허용하므로 `execute: async ({ writer }) => { ... const mm = await convertToModelMessages(messages); ... }` 로 작성하고 `messages: mm` 를 넘긴다. (위 스니펫의 `as never` 우회는 쓰지 말 것 — async/await로 처리.)

권장 최종형 execute:

```ts
execute: async ({ writer }) => {
  if (sources.length > 0) writer.write({ type: "data-sources", id: "sources", data: sources });
  const result = streamText({
    model: google("gemini-2.5-flash"),
    system,
    messages: await convertToModelMessages(messages),
  });
  writer.merge(result.toUIMessageStream());
},
```

- data part는 **텍스트보다 먼저** write → 클라가 답변 스트리밍 시작 전에 출처 카드를 그릴 수 있음.
- 검색 0건이면 write 생략(빈 카드 방지).
- `onError`는 문자열을 반환해 클라 `error.message`로 노출(기본은 마스킹). 게이트 401/404는 기존대로 `Response`로 즉시 반환되어 useChat의 `error`로 잡힘.

---

## 5. 클라이언트 — `src/app/wikis/[slug]/chat/WikiChat.tsx`

기존 시그니처 `WikiChat({ slug, canWrite })` 유지. `SaveButton`/`saveAnswerAction`/뷰어·역할 게이트(`canWrite`) 유지.

### 5.1 신규 헬퍼 컴포넌트

```tsx
// 어시스턴트 메시지에서 sources data part 추출
function sourcesOf(m: WikiUIMessage): ChatSource[] {
  const part = (m.parts ?? []).find((p) => p.type === "data-sources") as
    | { type: "data-sources"; data: ChatSource[] }
    | undefined;
  return part?.data ?? [];
}

// 마크다운 렌더 (streamdown, XSS 하드닝)
import { Streamdown } from "streamdown";

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="wiki-content text-sm">
      <Streamdown
        parseIncompleteMarkdown          // 기본 true, 명시
        allowedLinkPrefixes={["/", "https://github.com"]}   // 내부 위키 경로 + 필요 도메인
        allowedImagePrefixes={[]}         // 이미지 인라인 금지(필요 시 CDN prefix 추가)
      >
        {content}
      </Streamdown>
    </div>
  );
}

// 클릭 가능한 출처 카드 (source 히트는 비링크)
function SourceCards({ slug, sources }: { slug: string; sources: ChatSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="mt-3 pt-2 border-t border-gray-200 flex flex-wrap gap-2">
      {sources.map((s) =>
        s.pageSlug ? (
          <a
            key={s.n}
            href={`/wikis/${encodeURIComponent(slug)}/${encodeURIComponent(s.pageSlug)}`}
            className="text-xs bg-white border rounded-md px-2 py-1 hover:border-blue-400"
          >
            <span className="text-gray-400">[{s.n}]</span> {s.pageTitle}
            {s.heading ? <span className="text-gray-400"> › {s.heading}</span> : null}
          </a>
        ) : (
          <span key={s.n} className="text-xs bg-gray-50 border rounded-md px-2 py-1 text-gray-500">
            <span className="text-gray-400">[{s.n}]</span> {s.pageTitle}
          </span>
        )
      )}
    </div>
  );
}
```

> XSS: `allowedLinkPrefixes`를 `["/", ...]`로 좁혀 내부 위키 링크만 허용. `allowedImagePrefixes`는 빈 배열(트래킹 이미지 차단). `rehypePlugins`를 오버라이드하지 말 것(배열 통째 교체 시 sanitize/harden이 빠짐).

### 5.2 useChat 훅 (v6 시그니처)

```tsx
const {
  messages, sendMessage, status, stop, regenerate, error, clearError,
} = useChat<WikiUIMessage>({
  transport: new DefaultChatTransport({ api: `/api/wikis/${encodeURIComponent(slug)}/chat` }),
});
const busy = status === "submitted" || status === "streaming";
```

### 5.3 요구 기능 매핑

- **(a) 마크다운 스트리밍 렌더** — 어시스턴트 버블에서 `text` 대신 `<MarkdownMessage content={text} />`. 사용자 버블은 현행 `whitespace-pre-wrap` 유지.
- **(b) 출처 카드** — 어시스턴트 버블 하단에 `<SourceCards slug={slug} sources={sourcesOf(m)} />`.
- **(c) input 활성 + 중지** — `<textarea disabled={false}>`(항상 활성). 버튼: `busy ? <button onClick={()=>stop()}>중지</button> : <button type="submit">보내기</button>`.
- **(d) 자동 스크롤** — 컨테이너에 `ref`, `useEffect(()=>{ endRef.current?.scrollIntoView({behavior:"smooth"}); }, [messages])` (스트리밍 중 messages 갱신마다 하단 정렬). 리스트 끝에 `<div ref={endRef} />`.
- **(e) 에러 표시+재시도** — `status==="error" && error`일 때 `role="alert"` 배너: `오류: {error.message}` + `<button onClick={()=>regenerate()}>재시도</button>` + `<button onClick={()=>clearError()}>닫기</button>`.
- **(f) Enter 전송** — textarea `onKeyDown`: `if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); submit(); }`. Shift+Enter는 개행.
- **(g) 위키에 저장** — `SaveButton` 그대로. `!busy && text.trim()`일 때만 렌더(현행 유지). `canWrite` 게이트 유지.

### 5.4 제출 로직

```tsx
function submit() {
  const q = input.trim();
  if (!q || busy) return;         // 전송 자체는 busy 중 막되(중복 방지), input은 열어둠
  sendMessage({ text: q });
  setInput("");
}
```

> input을 열어두되 `sendMessage`만 busy에서 막는다. 사용자는 다음 질문을 미리 타이핑 가능(완성형 UX).

### 5.5 빈/로딩 상태

- `status==="submitted"`(첫 청크 대기): 타이핑 인디케이터(점 애니메이션 또는 "검색 중…").
- `status==="streaming"`: 실시간 마크다운 렌더(streamdown이 불완전 토큰 보정).

---

## 6. 스타일 노트

- 어시스턴트 버블을 `.wiki-content`로 감싸 기존 프로즈 CSS(globals.css L42-56: h1~h3/ul/ol/a/code/pre/blockquote/table) 재사용. `text-sm` 컨텍스트로 채팅 크기 조정.
- 버블 배경 `bg-gray-100`과 `.wiki-content code/pre`의 `#f3f4f6`가 유사해 대비 약함 → 어시스턴트 버블 배경을 `bg-white border`로 바꾸는 것 권장(코드블록 가독성).
- streamdown이 `[&_pre]:overflow-x-auto` 등 추가 클래스 필요 시 `className`으로 주입 가능(단 `.wiki-content pre`가 이미 overflow 처리).

---

## 7. 검증 계획 (브라우저)

`npm run dev` 후 `/wikis/<slug>/chat`:

1. **스트리밍 마크다운** — 질문 전송 → 답변이 실시간으로 그려지며 **테이블/리스트/코드/헤딩이 렌더**되고, 스트리밍 중 `**`나 미완 테이블에서 깨지거나 깜빡이지 않는지 확인.
2. **출처 카드** — 답변 상/하단에 `[n] 페이지제목 › 헤딩` 카드가 뜨고, 클릭 시 `/wikis/<slug>/<pageSlug>`로 이동. 한글 슬러그 URL 인코딩 정상. `source` 타입 히트는 비링크(회색)로 표시.
3. **인용 일치** — 답변 본문 `[3]`이 3번 카드와 동일 페이지를 가리키는지(n = i+1 정렬).
4. **중지** — 긴 답변 스트리밍 중 "중지" 클릭 → 즉시 멈추고 status `ready` 복귀, input 계속 사용 가능.
5. **input 활성** — 스트리밍 중에도 textarea에 타이핑 가능, Shift+Enter 개행 / Enter 전송(busy면 전송만 무시).
6. **에러+재시도** — API 키 제거나 네트워크 차단으로 500 유발 → `role="alert"` 배너 노출, "재시도"로 `regenerate()` 동작, "닫기"로 `clearError()`. 로그아웃 상태 401 / 비멤버 404도 배너로 표시.
7. **위키 저장** — 답변 완료 후(editor 권한) "위키에 저장" → "위키에 저장됨 → 보기" 링크가 `/wikis/<slug>/<pageSlug>`로 연결. viewer 권한(`canWrite=false`)이면 저장 버튼 미표시.
8. **자동 스크롤** — 답변이 뷰포트보다 길어질 때 하단이 자동으로 따라오는지.
9. **타입 체크** — `npm run build` (또는 tsc)로 `WikiUIMessage` 제네릭이 route/클라 양쪽에서 통과하는지.

---

## 8. 변경 파일 요약

| 파일 | 작업 |
|---|---|
| `src/app/api/wikis/[id]/chat/types.ts` | 신규 — `ChatSource`, `WikiUIMessage` 등 공통 타입 |
| `src/app/api/wikis/[id]/chat/route.ts` | 수정 — `createUIMessageStream` + `data-sources` write, sources 매핑 |
| `src/app/wikis/[slug]/chat/WikiChat.tsx` | 수정 — streamdown 렌더, SourceCards, stop/스크롤/에러/textarea |
| `src/app/globals.css` | 수정 — `@source "../../node_modules/streamdown/dist/index.js";` 1줄 |
| `package.json` | `streamdown@2.5.0` 추가 (npm i) |

건드리지 않음: `saveAnswerAction`(actions.ts), 검색(search.ts), 세션/게이트, Quartz/빌드 설정.
