import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

const DOCUMENT_FILE_LIMIT = 200;

interface IndexedDocument {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly content: string;
}

const textAndJson = <T>(payload: T) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(payload, null, 2),
    },
  ],
  structuredContent: payload,
});

async function collectDocs(rootDir: string): Promise<ReadonlyArray<IndexedDocument>> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const docs: IndexedDocument[] = [];
  const pushDocument = async (absolutePath: string) => {
    const content = await fs.readFile(absolutePath, "utf8");
    const relativePath = path.relative(rootDir, absolutePath) || path.basename(absolutePath);
    docs.push({
      id: relativePath,
      title: path.basename(relativePath),
      path: absolutePath,
      content,
    });
  };

  const rootDocs = ["AGENTS.md", "plan-phase-1-t3-tools-mcp-server-orchestrator-mode.md"];
  for (const fileName of rootDocs) {
    const absolutePath = path.join(rootDir, fileName);
    try {
      await pushDocument(absolutePath);
    } catch {
      // Some workspaces may not have every optional planning doc checked in.
    }
  }

  const docRoots = [
    path.join(rootDir, "docs"),
    path.join(rootDir, "apps/server/src/linear/prompts"),
  ];
  const queue = [...docRoots];
  while (queue.length > 0 && docs.length < DOCUMENT_FILE_LIMIT) {
    const current = queue.shift()!;
    let entries: Array<{
      readonly name: string;
      readonly isDirectory: () => boolean;
      readonly isFile: () => boolean;
    }>;
    try {
      entries = (await fs.readdir(current, { withFileTypes: true })) as typeof entries;
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      await pushDocument(entryPath);
      if (docs.length >= DOCUMENT_FILE_LIMIT) {
        break;
      }
    }
  }

  return docs;
}

function scoreDocument(document: IndexedDocument, queryTokens: ReadonlyArray<string>): number {
  const haystack = `${document.title}\n${document.id}\n${document.content}`.toLowerCase();
  return queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function excerptDocument(document: IndexedDocument, queryTokens: ReadonlyArray<string>): string {
  const normalizedContent = document.content.replace(/\s+/g, " ").trim();
  if (normalizedContent.length === 0) {
    return "";
  }
  const lower = normalizedContent.toLowerCase();
  const firstToken = queryTokens.find((token) => lower.includes(token));
  const anchor = firstToken ? lower.indexOf(firstToken) : 0;
  const start = Math.max(0, anchor - 120);
  const end = Math.min(normalizedContent.length, anchor + 280);
  return normalizedContent.slice(start, end);
}

export function createT3DocsServer(rootDir: string) {
  const server = new McpServer({
    name: "t3-docs",
    version: "1.0.0",
  });

  server.registerTool(
    "search_documentation",
    {
      description: "Search AGENTS.md and project docs for relevant documentation.",
      inputSchema: {
        query: z.string().min(1),
      },
    },
    async ({ query }) => {
      const docs = await collectDocs(rootDir);
      const queryTokens = query
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
      const matches = docs
        .map((document) => ({
          id: document.id,
          title: document.title,
          score: scoreDocument(document, queryTokens),
          excerpt: excerptDocument(document, queryTokens),
        }))
        .filter((document) => document.score > 0)
        .toSorted(
          (left, right) => right.score - left.score || left.title.localeCompare(right.title),
        )
        .slice(0, 10);

      return textAndJson({
        success: true,
        matches,
      });
    },
  );

  server.registerTool(
    "get_document",
    {
      description: "Fetch a specific project documentation file by id/path.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      const docs = await collectDocs(rootDir);
      const document = docs.find((entry) => entry.id === id);
      if (!document) {
        return textAndJson({
          success: false,
          error: `Unknown document '${id}'.`,
        });
      }
      return textAndJson({
        success: true,
        document: {
          id: document.id,
          title: document.title,
          content: document.content,
        },
      });
    },
  );

  return server;
}
