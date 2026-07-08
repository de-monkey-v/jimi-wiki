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
      <main className="mx-auto max-w-sm px-6 py-20">
        <h1 className="text-xl font-bold">{t("invalidTitle")}</h1>
        <p className="text-sm text-gray-500 mt-2">{t("invalidDescription")}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-2xl font-bold mb-6">{t("acceptTitle")}</h1>
      <InviteForm token={token} email={invite!.email ?? ""} />
    </main>
  );
}
