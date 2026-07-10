import { getTranslations } from "next-intl/server";
import { RouteModal } from "@/components/RouteModal";
import SettingsPage from "../../settings/page";

export default async function SettingsModal({ params }: { params: Promise<{ slug: string }> }) {
  const t = await getTranslations("WikisSlugSettingsPage");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);

  return (
    <RouteModal title={t("title")} fullPageHref={`/wikis/${encodeURIComponent(slug)}/settings`}>
      <SettingsPage params={params} />
    </RouteModal>
  );
}
