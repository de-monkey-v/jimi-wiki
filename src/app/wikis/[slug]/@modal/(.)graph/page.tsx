import { getTranslations } from "next-intl/server";
import { RouteModal } from "@/components/RouteModal";
import GraphPage from "../../graph/page";

export const dynamic = "force-dynamic";

export default async function GraphModal({ params }: { params: Promise<{ slug: string }> }) {
  const t = await getTranslations("WikisSlugGraphPage");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);

  return (
    <RouteModal title={t("title")} fullPageHref={`/wikis/${encodeURIComponent(slug)}/graph`}>
      <GraphPage params={params} />
    </RouteModal>
  );
}
