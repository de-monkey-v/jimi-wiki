import "dotenv/config";
import { GoogleGenAI, FunctionCallingConfigMode, Type } from "@google/genai";
import { EMBED_DIM } from "../src/lib/embed-config";

// SDK 표면 실측: 임베딩(배열→다중), function calling 응답 형태
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function main() {
  // 1) 임베딩 — contents 배열 허용 여부 + values 차원
  const emb = await ai.models.embedContent({
    model: "gemini-embedding-001",
    contents: ["안녕 세계, 하이브리드 검색 테스트", "second document"],
    config: { outputDimensionality: EMBED_DIM, taskType: "RETRIEVAL_DOCUMENT" },
  });
  console.log("EMB count:", emb.embeddings?.length, "dim:", emb.embeddings?.[0]?.values?.length);

  // 2) function calling — res.functionCalls / candidates[0].content 형태
  const res = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: "add 라는 도구로 a=2, b=3을 더해줘." }] }],
    config: {
      tools: [{
        functionDeclarations: [{
          name: "add",
          description: "두 수를 더한다",
          parameters: {
            type: Type.OBJECT,
            properties: { a: { type: Type.NUMBER }, b: { type: Type.NUMBER } },
            required: ["a", "b"],
          },
        }],
      }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
    },
  });
  console.log("FUNCTION_CALLS:", JSON.stringify(res.functionCalls));
  console.log("CANDIDATE_ROLE:", res.candidates?.[0]?.content?.role);
  console.log("CANDIDATE_PARTS:", JSON.stringify(res.candidates?.[0]?.content?.parts));
  console.log("TEXT:", res.text ?? "(none)");
}

main().catch((e) => {
  console.error("PROBE FAILED:", e?.message ?? e);
  process.exit(1);
});
