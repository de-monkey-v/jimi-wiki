import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type SeenRequest = { method: string; url: string; body: unknown; headers: Record<string, string | string[] | undefined> };

test("MCP personal/project profiles expose the intended tools and route payloads", async () => {
  const seen: SeenRequest[] = [];
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method ?? "", url: req.url ?? "", body, headers: req.headers });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/api/wikis/personal-profile") {
        res.end(JSON.stringify({ id: "personal", slug: "personal-profile", title: "Personal", kind: "personal", role: "editor" }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/wikis/project-profile") {
        res.end(JSON.stringify({ id: "project", slug: "project-profile", title: "Project", kind: "project", role: "editor" }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind");
  const base = `http://127.0.0.1:${address.port}`;

  async function connect(slug: string) {
    const client = new Client({ name: "jimi-wiki-integration", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["mcp/server.mjs"],
      cwd: process.cwd(),
      env: {
        JIMI_WIKI_URL: base,
        JIMI_WIKI_API_KEY: "integration-key",
        JIMI_WIKI_SLUG: slug,
      },
      stderr: "pipe",
    });
    await client.connect(transport);
    return { client, transport };
  }

  try {
    const personal = await connect("personal-profile");
    const personalTools = (await personal.client.listTools()).tools.map((tool) => tool.name);
    for (const expected of [
      "preserve_url", "preserve_text", "curate_url", "curate_text", "curate_source",
      "record_document", "record_worklog", "search_documents", "append_document",
      "save_link", "list_saved_links", "promote_saved_link",
      "trash_saved_link", "restore_saved_link", "list_trash", "trash_page", "restore_page", "trash_source", "restore_source",
    ]) {
      assert.ok(personalTools.includes(expected), `personal profile missing ${expected}`);
    }
    assert.equal(personalTools.includes("delete_page"), false, "permanent delete tool must not be exposed");
    assert.match(personal.client.getInstructions() ?? "", /비밀번호·API key·token/);
    assert.match(personal.client.getInstructions() ?? "", /읽을거리는 항상 요약을 시도한다/);

    const missingSummary = await personal.client.callTool({
      name: "save_link",
      arguments: { url: "https://example.com/missing-summary" },
    });
    assert.equal(missingSummary.isError, true);
    const missingSummaryContent = missingSummary.content as { type: string; text?: string }[];
    assert.match(String(missingSummaryContent[0]?.type === "text" ? missingSummaryContent[0].text : ""), /summary_required/);
    assert.equal(seen.some((request) => request.url.endsWith("/saved-links") && (request.body as { url?: string })?.url?.includes("missing-summary")), false);

    await personal.client.callTool({ name: "preserve_url", arguments: { url: "https://example.com/raw" } });
    await personal.client.callTool({
      name: "record_worklog",
      arguments: {
        title: "MCP Worklog",
        goal: "goal",
        changes: "changes",
        decisions: "decisions",
        problemsAndSolutions: "solutions",
        verification: "verified",
        remainingWork: "remaining",
        references: "refs",
      },
    });
    await personal.client.callTool({ name: "search_documents", arguments: { query: "worklog", k: 4 } });
    await personal.client.callTool({ name: "promote_saved_link", arguments: { id: "saved-1" } });
    await personal.client.callTool({ name: "save_link", arguments: { url: "https://example.com/?utm_source=test", summary: "- 핵심\n\n볼 가치: 있음" } });
    await personal.client.callTool({
      name: "save_link",
      arguments: { url: "https://example.com/extract-failed", summary: "   ", summaryUnavailableReason: "사이트가 본문 요청을 차단함" },
    });
    await personal.client.callTool({ name: "trash_saved_link", arguments: { id: "saved-1" } });
    await personal.client.callTool({ name: "restore_saved_link", arguments: { id: "saved-1" } });
    await personal.transport.close();

    const preserve = seen.find((request) => request.url.endsWith("/api/wikis/personal-profile/ingest") && (request.body as { mode?: string })?.mode === "preserve");
    assert.deepEqual(preserve?.body, { url: "https://example.com/raw", mode: "preserve" });
    assert.equal(preserve?.headers["x-jimi-model-trust"], "external");
    const worklog = seen.find((request) => request.url.endsWith("/api/wikis/personal-profile/documents") && (request.body as { type?: string })?.type === "worklog");
    const worklogBody = (worklog?.body as { body?: string })?.body;
    assert.ok(worklogBody);
    assert.deepEqual(worklogBody.split(/\n(?=## )/).map((section) => section.match(/^## ([^\n]+)/)?.[1]), [
      "목표", "변경 사항", "결정", "문제와 해결", "검증", "남은 작업", "참고 자료",
    ]);
    assert.ok(seen.some((request) => request.url.includes("/search?") && request.url.includes("scope=documents")));
    assert.ok(seen.some((request) => request.url.endsWith("/saved-links/saved-1/promote")));
    assert.ok(seen.some((request) => request.method === "DELETE" && request.url.endsWith("/saved-links/saved-1")));
    assert.ok(seen.some((request) => request.url.endsWith("/saved-links/saved-1/restore")));
    const summarized = seen.find((request) => request.url.endsWith("/saved-links") && (request.body as { summary?: string })?.summary);
    assert.deepEqual(summarized?.body, { url: "https://example.com/?utm_source=test", summary: "- 핵심\n\n볼 가치: 있음" });
    const fallback = seen.find((request) => request.url.endsWith("/saved-links") && (request.body as { url?: string })?.url?.includes("extract-failed"));
    assert.deepEqual(fallback?.body, { url: "https://example.com/extract-failed" });

    const project = await connect("project-profile");
    const projectTools = (await project.client.listTools()).tools.map((tool) => tool.name);
    assert.equal(projectTools.includes("trash_page"), true);
    assert.equal(projectTools.includes("delete_page"), false);
    assert.match(project.client.getInstructions() ?? "", /최종 응답 직전에 record_worklog를 정확히 1회/);
    assert.match(project.client.getInstructions() ?? "", /단순 질문·상태 확인/);
    await project.transport.close();
  } finally {
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  }
});
