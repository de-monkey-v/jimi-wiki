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
    <main className="mx-auto compact-measure space-y-6 px-4 py-10 sm:px-6">
      <header className="page-header">
        <div className="page-breadcrumb"><Link href="/wikis">← {t("backToWikis")}</Link></div>
        <p className="page-kicker">Access registry</p>
        <h1 className="page-title">{t("title")}</h1>
        <p className="page-description">{t("description")}</p>
      </header>

      <section className="surface-panel space-y-3 p-5">
        <h2 className="font-semibold">{t("issuedKeys")}</h2>
        {keys.length === 0 ? (
          <p className="text-sm text-stone-400">{t("empty")}</p>
        ) : (
          <ul className="space-y-2">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-3 border-b border-stone-100 py-2 text-sm last:border-0">
                <span className="min-w-0">
                  <span className="font-medium">{k.name}</span>{" "}
                  <code className="rounded bg-stone-100 px-1.5 py-0.5 text-xs">{k.prefix}…</code>{" "}
                  <span className="text-xs text-stone-500">
                    · {k.wiki ? t("wikiLabel", { title: k.wiki.title }) : t("allWikis")} · {k.maxRole ? roleLabel(k.maxRole) : t("noRoleLimit")}
                    {" · "}
                    {k.expiresAt
                      ? k.expired
                        ? <span className="text-rose-600">{t("expired")}</span>
                        : t("expiresAt", { date: k.expiresAt.toISOString().slice(0, 10) })
                      : t("noExpiry")}
                  </span>{" "}
                  <span className="text-stone-400">
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
