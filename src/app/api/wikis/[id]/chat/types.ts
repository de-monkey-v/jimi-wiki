import type { UIMessage } from "ai";

export type ChatSource = {
  n: number; // 프롬프트의 [번호] 인용과 1:1 (i+1)
  kind: "page" | "source"; // 근거 문서 종류(모달 조회 분기)
  slug: string; // page slug 또는 원문 slug (둘 다 해소됨)
  title: string;
  heading?: string;
};

export type WikiChatMetadata = { createdAt?: number };

// data part 맵: key 'sources' → type:'data-sources', data: ChatSource[]
export type WikiChatDataParts = { sources: ChatSource[] };

export type WikiUIMessage = UIMessage<WikiChatMetadata, WikiChatDataParts>;
