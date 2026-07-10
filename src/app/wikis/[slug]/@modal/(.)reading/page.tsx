import { getTranslations } from "next-intl/server";
import { RouteModal } from "@/components/RouteModal";
import ReadingPage from "../../reading/page";

export const dynamic = "force-dynamic";

export default async function ReadingModal({ params }: { params: Promise<{ slug: string }> }) {
  const t = await getTranslations("WikisSlugReadingPage");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);

  return (
    <RouteModal title={t("title")} fullPageHref={`/wikis/${encodeURIComponent(slug)}/reading`}>
      <ReadingPage params={params} />
    </RouteModal>
  );
}
