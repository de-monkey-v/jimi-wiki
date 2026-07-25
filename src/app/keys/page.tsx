import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { listApiKeys } from "@/lib/apikey";
import { listWikisForUser } from "@/lib/wiki";
import { IssueKeyForm } from "./IssueKeyForm";
import { RevokeButton } from "./RevokeButton";

export const dynamic = "force-dynamic";

export default async function KeysPage() {
  const t = await getTranslations("KeysPage");
  const userId = await getCurrentUserId();
  const [keys, wikis] = await Promise.all([listApiKeys(userId), listWikisForUser(userId)]);
  const roleLabel = (role: string) =>
    role === "viewer" || role === "editor" ? t(`role.${role}`) : role;

  return (
    <main className="mx-auto compact-measure px-6 py-10 space-y-6">
      <div>
        <Link href="/wikis" className="text-sm text-gray-400 hover:underline">← {t("backToWikis")}</Link>
        <h1 className="text-2xl font-bold mt-1">{t("title")}</h1>
        <p className="text-sm text-gray-500">{t("description")}</p>
      </div>

      <section className="border rounded-lg p-4 space-y-2">
        <h2 className="font-semibold">{t("issuedKeys")}</h2>
        {keys.length === 0 ? (
          <p className="text-sm text-gray-400">{t("empty")}</p>
        ) : (
          <ul className="space-y-2">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-medium">{k.name}</span>{" "}
                  <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{k.prefix}…</code>{" "}
                  <span className="text-xs text-gray-500">
                    · {k.wiki ? t("wikiLabel", { title: k.wiki.title }) : t("allWikis")} · {k.maxRole ? roleLabel(k.maxRole) : t("noRoleLimit")}
                    {" · "}
                    {k.expiresAt
                      ? k.expired
                        ? <span className="text-red-600">{t("expired")}</span>
                        : t("expiresAt", { date: k.expiresAt.toISOString().slice(0, 10) })
                      : t("noExpiry")}
                  </span>{" "}
                  <span className="text-gray-400">
                    {k.lastUsedAt ? t("lastUsed", { date: k.lastUsedAt.toISOString().slice(0, 10) }) : t("neverUsed")}
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
