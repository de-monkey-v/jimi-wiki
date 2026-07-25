import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";
import InviteForm from "./InviteForm";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const t = await getTranslations("InviteTokenPage");
  const { token } = await params;
  const invite = await prisma.invite.findUnique({ where: { token } });
  const invalid = !invite || !!invite.usedAt || (invite.expiresAt != null && invite.expiresAt < new Date());

  if (invalid) {
    return (
      <main className="mx-auto compact-measure px-4 py-16 sm:px-6 sm:py-20">
        <div className="surface-panel mx-auto max-w-sm p-6 sm:p-8">
        <p className="page-kicker">jimi-wiki</p>
        <h1 className="page-title">{t("invalidTitle")}</h1>
        <p className="page-description">{t("invalidDescription")}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto compact-measure px-4 py-16 sm:px-6 sm:py-20">
      <div className="surface-panel mx-auto max-w-sm p-6 sm:p-8">
      <header className="page-header">
        <p className="page-kicker">jimi-wiki</p>
        <h1 className="page-title">{t("acceptTitle")}</h1>
      </header>
      <InviteForm token={token} email={invite!.email ?? ""} />
      </div>
    </main>
  );
}
