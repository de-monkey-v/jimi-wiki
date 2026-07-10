import { getTranslations } from "next-intl/server";
import { RouteModal } from "@/components/RouteModal";
import WikiDocsPage from "../../docs/page";

export default async function DocsModal({ params }: { params: Promise<{ slug: string }> }) {
  const t = await getTranslations("DocsPage");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const fullPageHref = `/wikis/${encodeURIComponent(slug)}/docs`;

  return (
    <RouteModal title={t("title")} fullPageHref={fullPageHref}>
      <WikiDocsPage params={params} />
    </RouteModal>
  );
}
