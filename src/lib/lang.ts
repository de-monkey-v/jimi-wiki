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
 * 스크립트 기반 언어 추정(경량·결정적). **지배 스크립트**(최다 문자)로 판정 — 영어 본문에 섞인
 * 소수의 한글/한자 한 글자가 전체 판정을 뒤집지 않도록 first-match가 아니라 카운트로 고른다.
 * 가나가 있으면 일본어(한자 동반 가능). 가나 없는 한자만이면 중국어. 전부 없으면 영어.
 */
export function detectLang(text: string): { code: LangCode; name: string } {
  const kana = (text.match(/[぀-ヿ]/g) || []).length; // 히라가나+가타카나
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const han = (text.match(/[一-鿿]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;

  // 가나가 하나라도 있으면 일본어(한자를 곁들인 일본어 포함) — 단, 다른 스크립트가 압도적이면 그쪽.
  if (kana > 0 && kana + han >= Math.max(hangul, latin)) return { code: "ja", name: LANG_NAME.ja };

  const scores: [LangCode, number][] = [
    ["ko", hangul],
    ["zh", han],
    ["en", latin],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [code, top] = scores[0];
  return top > 0 ? { code, name: LANG_NAME[code] } : { code: "en", name: LANG_NAME.en };
}
