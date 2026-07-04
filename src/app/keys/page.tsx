import Link from "next/link";
import { getCurrentUserId } from "@/lib/session";
import { listApiKeys } from "@/lib/apikey";
import { listWikisForUser } from "@/lib/wiki";
import { IssueKeyForm } from "./IssueKeyForm";
import { RevokeButton } from "./RevokeButton";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = { viewer: "읽기 전용", editor: "편집" };

export default async function KeysPage() {
  const userId = await getCurrentUserId();
  const [keys, wikis] = await Promise.all([listApiKeys(userId), listWikisForUser(userId)]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 space-y-6">
      <div>
        <Link href="/wikis" className="text-sm text-gray-400 hover:underline">← 내 위키</Link>
        <h1 className="text-2xl font-bold mt-1">API 키</h1>
        <p className="text-sm text-gray-500">외부 스킬이 콘텐츠 API를 호출할 때 쓰는 Bearer 토큰입니다.</p>
      </div>

      <section className="border rounded-lg p-4 space-y-2">
        <h2 className="font-semibold">발급된 키</h2>
        {keys.length === 0 ? (
          <p className="text-sm text-gray-400">아직 없음.</p>
        ) : (
          <ul className="space-y-2">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-medium">{k.name}</span>{" "}
                  <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{k.prefix}…</code>{" "}
                  <span className="text-xs text-gray-500">
                    · {k.wiki ? `위키: ${k.wiki.title}` : "전체 위키"} · {k.maxRole ? (ROLE_LABEL[k.maxRole] ?? k.maxRole) : "권한 제한 없음"}
                    {" · "}
                    {k.expiresAt
                      ? k.expired
                        ? <span className="text-red-600">만료됨</span>
                        : `만료 ${k.expiresAt.toISOString().slice(0, 10)}`
                      : "무기한"}
                  </span>{" "}
                  <span className="text-gray-400">
                    {k.lastUsedAt ? `마지막 사용 ${k.lastUsedAt.toISOString().slice(0, 10)}` : "미사용"}
                  </span>
                </span>
                <RevokeButton id={k.id} />
              </li>
            ))}
          </ul>
        )}
        <IssueKeyForm wikis={wikis.map((w) => ({ id: w.id, title: w.title }))} />
      </section>
    </main>
  );
}
