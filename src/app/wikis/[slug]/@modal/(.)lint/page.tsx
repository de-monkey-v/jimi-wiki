import { getTranslations } from "next-intl/server";
import { RouteModal } from "@/components/RouteModal";
import LintPage from "../../lint/page";

export const dynamic = "force-dynamic";

export default async function LintModal({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ deep?: string; suggest?: string }>;
}) {
  const t = await getTranslations("WikisSlugLintPage");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const query = await searchParams;
  const fullPageQuery = new URLSearchParams();
  if (query.deep === "1") fullPageQuery.set("deep", "1");
  if (query.suggest === "1") fullPageQuery.set("suggest", "1");
  const suffix = fullPageQuery.size > 0 ? `?${fullPageQuery}` : "";

  return (
    <RouteModal title={t("title")} fullPageHref={`/wikis/${encodeURIComponent(slug)}/lint${suffix}`}>
      <LintPage params={params} searchParams={searchParams} />
    </RouteModal>
  );
}
