"use client";

import {
  cloneElement,
  isValidElement,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

export const RESEARCH_CODE_MOBILE_QUERY = "(max-width: 520px)";

export type ResearchCodeLabels = {
  copy: string;
  download: string;
  showOriginalWidth: string;
  wrapLongLines: string;
};

type MarkdownCodeElementProps = {
  children?: ReactNode;
  className?: string;
  "data-block"?: string;
};

function subscribeToMobileCodeDefault(onChange: () => void) {
  const media = window.matchMedia(RESEARCH_CODE_MOBILE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

const getMobileCodeDefault = () => window.matchMedia(RESEARCH_CODE_MOBILE_QUERY).matches;
const getServerCodeDefault = () => false;

export function codeTextFromNode(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(codeTextFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return codeTextFromNode(value.props.children);
  return "";
}

export function codeLanguageFromClassName(className?: string): string {
  return className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? "";
}

function WrapLinesIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 16 16" width="16">
      <path
        d="M2.25 4.25h8.5a3 3 0 0 1 0 6H6.5m0 0 2-2m-2 2 2 2M2.25 7.25h5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </svg>
  );
}

export function ResearchCodeBlock({
  children,
  labels,
  sourceActions,
}: {
  children: ReactNode;
  labels: ResearchCodeLabels;
  sourceActions?: ReactNode;
}) {
  const mobileDefault = useSyncExternalStore(
    subscribeToMobileCodeDefault,
    getMobileCodeDefault,
    getServerCodeDefault,
  );
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const wrapped = wrapOverride ?? mobileDefault;
  const wrapMode = wrapOverride === null ? "auto" : wrapped ? "wrap" : "original";
  const wrapLabel = wrapped ? labels.showOriginalWidth : labels.wrapLongLines;

  return (
    <div
      className="research-code-frame"
      data-research-code-frame=""
      data-wrap-mode={wrapMode}
      data-wrapped={String(wrapped)}
    >
      <div className="research-code-actions" data-streamdown="code-block-actions">
        {sourceActions}
        <button
          aria-label={wrapLabel}
          aria-pressed={wrapped}
          className="research-code-action research-code-wrap-toggle"
          onClick={() => setWrapOverride(!wrapped)}
          title={wrapLabel}
          type="button"
        >
          <WrapLinesIcon />
          <span className="sr-only">{wrapLabel}</span>
        </button>
      </div>
      {children}
    </div>
  );
}

/**
 * Streamdown의 기본 pre가 하던 data-block 표시는 유지하면서, 일반 fenced code에만
 * 연구 문서용 보기 도구를 덧씌운다. Mermaid는 기본 도표 렌더러와 controls를 그대로 탄다.
 */
export function ResearchCodePre({
  children,
  labels,
  renderSourceActions,
}: {
  children?: ReactNode;
  labels: ResearchCodeLabels;
  renderSourceActions?: (source: { code: string; language: string }) => ReactNode;
}) {
  if (!isValidElement<MarkdownCodeElementProps>(children)) return <>{children}</>;

  const codeElement = children as ReactElement<MarkdownCodeElementProps>;
  const language = codeLanguageFromClassName(codeElement.props.className);
  const blockElement = cloneElement(codeElement, { "data-block": "true" });
  if (language.toLowerCase() === "mermaid") return blockElement;
  const code = codeTextFromNode(codeElement.props.children);

  return (
    <ResearchCodeBlock
      labels={labels}
      sourceActions={renderSourceActions?.({ code, language })}
    >
      {blockElement}
    </ResearchCodeBlock>
  );
}
