import { getTranslations } from "next-intl/server";
import { RouteModal } from "@/components/RouteModal";
import IngestPage from "../../ingest/page";

export default async function IngestModal({ params }: { params: Promise<{ slug: string }> }) {
  const t = await getTranslations("WikisSlugWikiActions");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);

  return (
    <RouteModal title={t("ingestTitle")} fullPageHref={`/wikis/${encodeURIComponent(slug)}/ingest`}>
      <IngestPage params={params} />
    </RouteModal>
  );
}
