import "server-only";
import { prisma } from "@/lib/db";
import { normalizeSlug } from "@/lib/markdown";
import { isReservedSlug } from "@/lib/ontology";
import {
  MAX_RESEARCH_SOURCES,
  inspectResearchMarkdown,
} from "@/lib/research-markdown";
import {
  ContentNotFoundError,
  ContentVersionConflictError,
  createPageSnapshot,
  updatePageSnapshot,
} from "@/lib/content-store";
import { stageExternalPageProposal } from "@/lib/builds";
import { refreshPageDerivedState } from "@/lib/page-projections";
import type { DocumentType, Page, RevisionActor } from "@/generated/prisma/client";

export const DOCUMENT_TYPES = [
  "general",
  "worklog",
  "troubleshooting",
  "decision",
  "reference",
  "plan",
  "spec",
  "research",
] as const satisfies readonly DocumentType[];

export const WORKLOG_SECTIONS = [
  "목표",
  "변경 사항",
  "결정",
  "문제와 해결",
  "검증",
  "남은 작업",
  "참고 자료",
] as const;

export const MAX_DOCUMENT_BODY_BYTES = 1_048_576;
export const MAX_DOCUMENT_APPEND_BYTES = 65_536;

export class DocumentInputError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 413 = 400,
  ) {
    super(code);
    this.name = "DocumentInputError";
  }
}

export function parseDocumentType(value: unknown, fallback?: DocumentType): DocumentType | null {
  if (value === undefined && fallback) return fallback;
  return typeof value === "string" && DOCUMENT_TYPES.includes(value as DocumentType)
    ? value as DocumentType
    : null;
}

export function parseDocumentDate(value: unknown, fallback?: Date): Date | null {
  if (value === undefined && fallback) return fallback;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertDocumentBodySize(body: string, append = false): void {
  const max = append ? MAX_DOCUMENT_APPEND_BYTES : MAX_DOCUMENT_BODY_BYTES;
  if (byteLength(body) > max) throw new DocumentInputError("document_body_too_large", 413);
}

export function appendDocumentBody(current: string, addition: string): string {
  assertDocumentBodySize(addition, true);
  const next = current.length > 0 ? `${current}\n\n${addition}` : addition;
  assertDocumentBodySize(next);
  return next;
}

export function formatWorklog(input: Partial<Record<(typeof WORKLOG_SECTIONS)[number], string>>): string {
  return WORKLOG_SECTIONS.map((heading) => `## ${heading}\n\n${input[heading]?.trim() ?? ""}`).join("\n\n");
}

export function containsSecretMaterial(value: string): boolean {
  return [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:sk-proj-|sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}\b/i,
  ].some((pattern) => pattern.test(value));
}

export type DocumentWriteInput = {
  wikiId: string;
  userId: string | null;
  actor: Extract<RevisionActor, "human" | "agent">;
  externalAgent: boolean;
  slug?: string;
  title: string;
  body: string;
  documentType?: DocumentType;
  documentAt?: Date;
  category?: string | null;
  expectedVersion?: number;
  sourceSlugs?: string[];
};

export type DocumentWriteResult =
  | { created: boolean; staged: false; page: Page }
  | { created: false; staged: true; slug: string; currentVersion: number; buildId: string; draftId: string };

const isP2002 = (error: unknown) => (error as { code?: string })?.code === "P2002";

async function finishPage(page: Page): Promise<Page> {
  await refreshPageDerivedState(page.wikiId, page.id);
  return page;
}

function assertResearchSourceSlugInput(body: string, sourceSlugs: string[] | undefined): string[] {
  if (!sourceSlugs) throw new DocumentInputError("research_source_slugs_required");
  if (sourceSlugs.length < 1 || sourceSlugs.length > MAX_RESEARCH_SOURCES) {
    throw new DocumentInputError("invalid_research_source_count");
  }
  const normalized = sourceSlugs.map((slug) => normalizeSlug(slug));
  if (
    normalized.some((slug, index) => !slug || slug !== sourceSlugs[index]) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new DocumentInputError("invalid_research_source_slugs");
  }
  const inspected = inspectResearchMarkdown(body);
  if (inspected.invalidCitations.length > 0) {
    throw new DocumentInputError("invalid_research_citation");
  }
  if (inspected.mermaidIssues.length > 0) {
    throw new DocumentInputError(inspected.mermaidIssues[0].code);
  }
  if (
    inspected.citationSlugs.length !== normalized.length ||
    inspected.citationSlugs.some((slug, index) => slug !== normalized[index])
  ) {
    throw new DocumentInputError("research_citations_source_slugs_mismatch");
  }
  return inspected.citationSlugs;
}

async function resolveResearchSourceRevisionIds(input: {
  wikiId: string;
  body: string;
  sourceSlugs?: string[];
  externalAgent: boolean;
}): Promise<string[]> {
  const citationSlugs = assertResearchSourceSlugInput(input.body, input.sourceSlugs);
  const sources = await prisma.source.findMany({
    where: {
      wikiId: input.wikiId,
      slug: { in: citationSlugs },
      archivedAt: null,
      curationState: "preserved",
      ...(input.externalAgent ? { modelAccess: "external" as const } : {}),
    },
    select: {
      slug: true,
      currentVersion: true,
      revisions: {
        orderBy: { version: "desc" },
        take: 1,
        select: {
          id: true,
          version: true,
          archivedAt: true,
          modelAccess: true,
        },
      },
    },
  });
  const revisionBySlug = new Map(
    sources.flatMap((source) => {
      const revision = source.revisions[0];
      return revision &&
        revision.version === source.currentVersion &&
        revision.archivedAt === null &&
        (!input.externalAgent || revision.modelAccess === "external")
        ? [[source.slug, revision.id] as const]
        : [];
    }),
  );
  if (revisionBySlug.size !== citationSlugs.length) {
    throw new DocumentInputError("research_source_not_found", 404);
  }
  return citationSlugs.map((slug) => revisionBySlug.get(slug)!);
}

export async function writeDocument(input: DocumentWriteInput): Promise<DocumentWriteResult> {
  if (!input.title.trim()) throw new DocumentInputError("title_required");
  assertDocumentBodySize(input.body);
  if (containsSecretMaterial(`${input.title}\n${input.body}`)) {
    throw new DocumentInputError("secret_material_rejected");
  }
  const wanted = input.slug ? normalizeSlug(input.slug) : "";
  if (input.slug && (!wanted || isReservedSlug(wanted))) {
    throw new DocumentInputError("invalid_document_slug");
  }
  const existing = wanted
    ? await prisma.page.findUnique({ where: { wikiId_slug: { wikiId: input.wikiId, slug: wanted } } })
    : null;
  if (existing) {
    if (input.externalAgent && existing.modelAccess !== "external") throw new ContentNotFoundError("page");
    if (existing.archivedAt) throw new DocumentInputError("archived_slug_conflict", 409);
    if (existing.kind !== "document") throw new DocumentInputError("slug_conflict", 409);
    if (!input.expectedVersion) throw new DocumentInputError("expected_version_required", 400);
    if (existing.currentVersion !== input.expectedVersion) {
      throw new ContentVersionConflictError(input.expectedVersion, existing.currentVersion);
    }
    const documentType = input.documentType ?? existing.documentType;
    const documentAt = input.documentAt ?? existing.documentAt;
    if (!documentType || !documentAt) throw new DocumentInputError("document_metadata_missing", 409);
    if (documentType === "research" && existing.documentType !== "research") {
      throw new DocumentInputError("research_slug_conflict", 409);
    }
    if (documentType !== "research" && input.sourceSlugs !== undefined) {
      throw new DocumentInputError("document_source_provenance_forbidden");
    }
    const sourceRevisionIds = documentType === "research"
      ? await resolveResearchSourceRevisionIds(input)
      : [];
    if (input.externalAgent && (existing.origin === "human" || existing.origin === "mixed")) {
      const staged = await stageExternalPageProposal({
        wikiId: input.wikiId,
        userId: input.userId,
        page: {
          id: existing.id,
          slug: existing.slug,
          currentVersion: existing.currentVersion,
          parentId: existing.parentId,
          sortOrder: existing.sortOrder,
          modelAccess: existing.modelAccess,
          documentType: existing.documentType,
          documentAt: existing.documentAt,
        },
        title: input.title.trim(),
        body: input.body,
        kind: "document",
        category: input.category === undefined ? existing.category : input.category,
        documentType,
        documentAt,
        sourceRevisionIds,
      });
      return {
        created: false,
        staged: true,
        slug: existing.slug,
        currentVersion: existing.currentVersion,
        ...staged,
      };
    }
    const { page } = await updatePageSnapshot({
      wikiId: input.wikiId,
      pageId: existing.id,
      expectedVersion: input.expectedVersion,
      changes: {
        title: input.title.trim(),
        body: input.body,
        documentType,
        documentAt,
        ...(input.category !== undefined ? { category: input.category } : {}),
      },
      sourceRevisionIds,
      requireResearchSourcesPreserved: documentType === "research",
      context: { actor: input.actor, userId: input.userId, reason: "document update" },
    });
    return { created: false, staged: false, page: await finishPage(page) };
  }
  if (input.expectedVersion !== undefined) throw new ContentNotFoundError("page");
  const documentType = input.documentType ?? "general";
  const documentAt = input.documentAt ?? new Date();
  if (documentType !== "research" && input.sourceSlugs !== undefined) {
    throw new DocumentInputError("document_source_provenance_forbidden");
  }
  const sourceRevisionIds = documentType === "research"
    ? await resolveResearchSourceRevisionIds(input)
    : [];

  const root = wanted || normalizeSlug(input.title) || "document";
  for (let attempt = 0; attempt <= 50; attempt++) {
    const slug = attempt === 0 ? root : `${root}-${attempt + 1}`;
    try {
      const { page } = await createPageSnapshot({
        wikiId: input.wikiId,
        slug,
        title: input.title.trim(),
        body: input.body,
        kind: "document",
        documentType,
        documentAt,
        category: input.category === undefined
          ? documentType === "research" ? "research" : null
          : input.category,
        sourceId: null,
        sourceRevisionIds,
        requireResearchSourcesPreserved: documentType === "research",
        modelAccess: "external",
        context: { actor: input.actor, userId: input.userId, reason: "document create" },
      });
      return { created: true, staged: false, page: await finishPage(page) };
    } catch (error) {
      if (!isP2002(error)) throw error;
      if (wanted) throw new DocumentInputError("slug_conflict", 409);
    }
  }
  throw new DocumentInputError("slug_exhausted", 409);
}

export async function appendDocument(input: {
  wikiId: string;
  userId: string | null;
  actor: Extract<RevisionActor, "human" | "agent">;
  externalAgent: boolean;
  slug: string;
  content: string;
  expectedVersion: number;
}): Promise<DocumentWriteResult> {
  const page = await prisma.page.findUnique({ where: { wikiId_slug: { wikiId: input.wikiId, slug: input.slug } } });
  if (!page || page.archivedAt || (input.externalAgent && page.modelAccess !== "external")) {
    throw new ContentNotFoundError("page");
  }
  if (page.kind !== "document" || !page.documentType || !page.documentAt) {
    throw new DocumentInputError("not_a_document", 409);
  }
  if (page.documentType === "research") {
    throw new DocumentInputError("research_append_forbidden", 409);
  }
  if (page.currentVersion !== input.expectedVersion) {
    throw new ContentVersionConflictError(input.expectedVersion, page.currentVersion);
  }
  if (!input.content.length) throw new DocumentInputError("content_required");
  if (containsSecretMaterial(input.content)) throw new DocumentInputError("secret_material_rejected");
  return writeDocument({
    wikiId: input.wikiId,
    userId: input.userId,
    actor: input.actor,
    externalAgent: input.externalAgent,
    slug: page.slug,
    title: page.title,
    body: appendDocumentBody(page.body, input.content),
    documentType: page.documentType,
    documentAt: page.documentAt,
    category: page.category,
    expectedVersion: input.expectedVersion,
  });
}

export function listDocuments(input: {
  wikiId: string;
  type?: DocumentType;
  from?: Date;
  to?: Date;
  externalOnly?: boolean;
  take?: number;
}) {
  return prisma.page.findMany({
    where: {
      wikiId: input.wikiId,
      kind: "document",
      archivedAt: null,
      ...(input.type ? { documentType: input.type } : {}),
      ...(input.from || input.to
        ? { documentAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
        : {}),
      ...(input.externalOnly ? { modelAccess: "external" } : {}),
    },
    orderBy: [{ documentAt: "desc" }, { createdAt: "desc" }],
    take: Math.max(1, Math.min(input.take ?? 100, 200)),
    select: {
      id: true,
      slug: true,
      title: true,
      body: true,
      documentType: true,
      documentAt: true,
      category: true,
      origin: true,
      modelAccess: true,
      currentVersion: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}
