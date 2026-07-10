import { getTranslations } from "next-intl/server";
import { RouteModal } from "@/components/RouteModal";
import NewPage from "../../new/page";

export default async function NewPageModal({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ category?: string; kind?: string }>;
}) {
  const t = await getTranslations("WikisSlugWikiActions");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const query = await searchParams;
  const fullPageQuery = new URLSearchParams();
  if (query.category) fullPageQuery.set("category", query.category);
  if (query.kind) fullPageQuery.set("kind", query.kind);
  const suffix = fullPageQuery.size > 0 ? `?${fullPageQuery}` : "";

  return (
    <RouteModal title={t("newPageTitle")} fullPageHref={`/wikis/${encodeURIComponent(slug)}/new${suffix}`}>
      <NewPage params={params} searchParams={searchParams} />
    </RouteModal>
  );
}
