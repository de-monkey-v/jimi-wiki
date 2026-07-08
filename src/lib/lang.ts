// 클라이언트/서버 공용(server-only 없음). 텍스트의 주 언어를 스크립트로 추정.
// LLM 답변 언어를 "질문과 같은 언어"로 강제할 때, 감지한 언어를 프롬프트에 명시하기 위한 용도.
export type LangCode = "ko" | "ja" | "zh" | "en";

const LANG_NAME: Record<LangCode, string> = {
  ko: "Korean",
  ja: "Japanese",
  zh: "Chinese",
  en: "English",
};

/**
 * 스크립트 기반 언어 추정(경량·결정적). 한글 → 가나 → 한자 → 그 외(영어) 순.
 * 한국어는 한자 없이 한글로, 일본어는 가나로, 중국어는 한자만으로 구분된다(가나 없는 한자 = 중국어로 취급).
 */
export function detectLang(text: string): { code: LangCode; name: string } {
  if (/[가-힣]/.test(text)) return { code: "ko", name: LANG_NAME.ko };
  if (/[぀-ヿ]/.test(text)) return { code: "ja", name: LANG_NAME.ja };
  if (/[一-鿿]/.test(text)) return { code: "zh", name: LANG_NAME.zh };
  return { code: "en", name: LANG_NAME.en };
}
