/**
 * LinearAttachmentService - Downloads and manifests Linear issue attachments.
 *
 * Mirrors Cyrus's AttachmentService behavior: extracts `uploads.linear.app`
 * URLs from issue descriptions and comment bodies, downloads them locally,
 * and generates a manifest so the agent can reference them via the Read tool.
 *
 * @module LinearAttachmentService
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { Effect } from "effect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttachmentDownloadResult {
  readonly attachmentsDir: string;
  readonly manifest: string;
  readonly imageCount: number;
  readonly fileCount: number;
  readonly failedCount: number;
}

export interface IncrementalAttachmentResult {
  readonly manifest: string;
  readonly newImageCount: number;
  readonly newFileCount: number;
  readonly failedCount: number;
}

interface DownloadedFile {
  readonly filename: string;
  readonly originalUrl: string;
  readonly localPath: string;
  readonly isImage: boolean;
}

// ---------------------------------------------------------------------------
// URL extraction
// ---------------------------------------------------------------------------

const LINEAR_UPLOAD_URL_REGEX = /https:\/\/uploads\.linear\.app\/[a-zA-Z0-9/_.-]+/gi;
const MAX_ATTACHMENTS = 20;

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
]);

export function extractLinearUploadUrls(text: string): ReadonlyArray<string> {
  const matches = text.match(LINEAR_UPLOAD_URL_REGEX) ?? [];
  return [...new Set(matches)];
}

function guessExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = extname(pathname).toLowerCase();
    return ext || ".bin";
  } catch {
    return ".bin";
  }
}

function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

// ---------------------------------------------------------------------------
// Download logic
// ---------------------------------------------------------------------------

async function downloadFile(
  url: string,
  destinationPath: string,
  token: string,
): Promise<{ success: boolean; isImage: boolean }> {
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      console.warn(`[attachments] download failed: ${response.status} ${url}`);
      return { success: false, isImage: false };
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Detect content type from response headers
    const contentType = response.headers.get("content-type") ?? "";
    const isImage = contentType.startsWith("image/") || isImageExtension(extname(destinationPath));

    await writeFile(destinationPath, buffer);
    return { success: true, isImage };
  } catch (error) {
    console.warn(`[attachments] download error: ${url}`, error);
    return { success: false, isImage: false };
  }
}

// ---------------------------------------------------------------------------
// Manifest generation
// ---------------------------------------------------------------------------

function buildManifest(files: ReadonlyArray<DownloadedFile>, failedCount: number): string {
  if (files.length === 0 && failedCount === 0) {
    return "";
  }

  const images = files.filter((f) => f.isImage);
  const others = files.filter((f) => !f.isImage);

  const lines: string[] = [];
  lines.push("## Downloaded Attachments");
  lines.push("");
  lines.push(
    `Found ${files.length + failedCount} attachment(s). Downloaded ${files.length} (${images.length} images).${failedCount > 0 ? ` ${failedCount} failed.` : ""}`,
  );

  if (images.length > 0) {
    lines.push("");
    lines.push("### Images");
    for (const img of images) {
      lines.push(`- **${img.filename}** — Local path: \`${img.localPath}\``);
      lines.push(`  Original: ${img.originalUrl}`);
    }
    lines.push("");
    lines.push("You can use the Read tool to view these images.");
  }

  if (others.length > 0) {
    lines.push("");
    lines.push("### Files");
    for (const file of others) {
      lines.push(`- **${file.filename}** — Local path: \`${file.localPath}\``);
      lines.push(`  Original: ${file.originalUrl}`);
    }
    lines.push("");
    lines.push("You can use the Read tool to view these files.");
  }

  return lines.join("\n");
}

function buildIncrementalManifest(
  files: ReadonlyArray<DownloadedFile>,
  failedCount: number,
): string {
  if (files.length === 0 && failedCount === 0) {
    return "";
  }

  const images = files.filter((f) => f.isImage);
  const others = files.filter((f) => !f.isImage);

  const lines: string[] = [];
  lines.push("## New Attachments from Comment");
  lines.push("");
  lines.push(
    `Downloaded ${files.length} new attachment(s).${failedCount > 0 ? ` ${failedCount} failed.` : ""}`,
  );

  if (images.length > 0) {
    lines.push("");
    lines.push("### New Images");
    for (const img of images) {
      lines.push(`- **${img.filename}** — Local path: \`${img.localPath}\``);
    }
    lines.push("");
    lines.push("Use the Read tool to view.");
  }

  if (others.length > 0) {
    lines.push("");
    lines.push("### New Files");
    for (const file of others) {
      lines.push(`- **${file.filename}** — Local path: \`${file.localPath}\``);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Download all attachments from an issue description and its comments.
 *
 * Called during new session bootstrap. Creates an attachments directory
 * inside the worktree and returns a manifest for the prompt.
 *
 * The `token` is the Linear API/OAuth bearer token resolved by the caller
 * (typically from LinearOAuth or ServerSettings) so this function has no
 * service dependencies and is straightforward to test.
 */
export const downloadIssueAttachments = (input: {
  readonly issueDescription: string;
  readonly commentBodies: ReadonlyArray<string>;
  readonly attachmentsDir: string;
  readonly token: string | null;
}) =>
  Effect.gen(function* () {
    const token = input.token;
    if (!token) {
      return {
        attachmentsDir: input.attachmentsDir,
        manifest: "",
        imageCount: 0,
        fileCount: 0,
        failedCount: 0,
      } satisfies AttachmentDownloadResult;
    }

    // Collect all unique URLs from description + comments
    const allText = [input.issueDescription, ...input.commentBodies].join("\n");
    const urls = extractLinearUploadUrls(allText).slice(0, MAX_ATTACHMENTS);

    if (urls.length === 0) {
      return {
        attachmentsDir: input.attachmentsDir,
        manifest: "",
        imageCount: 0,
        fileCount: 0,
        failedCount: 0,
      } satisfies AttachmentDownloadResult;
    }

    yield* Effect.tryPromise({
      try: () => mkdir(input.attachmentsDir, { recursive: true }),
      catch: () => null,
    });

    const downloaded: DownloadedFile[] = [];
    let failedCount = 0;
    let imageIndex = 1;
    let fileIndex = 1;

    for (const url of urls) {
      const ext = guessExtension(url);
      const isImageGuess = isImageExtension(ext);
      const prefix = isImageGuess ? "image" : "attachment";
      const index = isImageGuess ? imageIndex : fileIndex;
      const filename = `${prefix}_${index}${ext}`;
      const localPath = join(input.attachmentsDir, filename);

      const result = yield* Effect.tryPromise({
        try: () => downloadFile(url, localPath, token),
        catch: () => ({ success: false, isImage: false }),
      });

      if (result.success) {
        const isImage = result.isImage || isImageGuess;
        downloaded.push({ filename, originalUrl: url, localPath, isImage });
        if (isImage) {
          imageIndex += 1;
        } else {
          fileIndex += 1;
        }
      } else {
        failedCount += 1;
      }
    }

    const manifest = buildManifest(downloaded, failedCount);
    return {
      attachmentsDir: input.attachmentsDir,
      manifest,
      imageCount: downloaded.filter((f) => f.isImage).length,
      fileCount: downloaded.filter((f) => !f.isImage).length,
      failedCount,
    } satisfies AttachmentDownloadResult;
  }).pipe(
    Effect.catch((error) => {
      console.warn("[attachments] issue attachment download failed", error);
      return Effect.succeed({
        attachmentsDir: input.attachmentsDir,
        manifest: "",
        imageCount: 0,
        fileCount: 0,
        failedCount: 0,
      } satisfies AttachmentDownloadResult);
    }),
  );

/**
 * Download new attachments from a continuation comment.
 *
 * Maintains numbering continuity with existing attachments in the directory.
 */
export const downloadCommentAttachments = (input: {
  readonly commentBody: string;
  readonly attachmentsDir: string;
  readonly token: string | null;
}) =>
  Effect.gen(function* () {
    const token = input.token;
    if (!token) {
      return {
        manifest: "",
        newImageCount: 0,
        newFileCount: 0,
        failedCount: 0,
      } satisfies IncrementalAttachmentResult;
    }

    const urls = extractLinearUploadUrls(input.commentBody);
    if (urls.length === 0) {
      return {
        manifest: "",
        newImageCount: 0,
        newFileCount: 0,
        failedCount: 0,
      } satisfies IncrementalAttachmentResult;
    }

    yield* Effect.tryPromise({
      try: () => mkdir(input.attachmentsDir, { recursive: true }),
      catch: () => null,
    });

    // Count existing attachments for numbering continuity
    const existingFiles = yield* Effect.tryPromise({
      try: () => readdir(input.attachmentsDir),
      catch: () => [] as string[],
    });
    let imageIndex = existingFiles.filter((f) => f.startsWith("image_")).length + 1;
    let fileIndex = existingFiles.filter((f) => f.startsWith("attachment_")).length + 1;

    const downloaded: DownloadedFile[] = [];
    let failedCount = 0;

    for (const url of urls.slice(0, MAX_ATTACHMENTS)) {
      const ext = guessExtension(url);
      const isImageGuess = isImageExtension(ext);
      const prefix = isImageGuess ? "image" : "attachment";
      const index = isImageGuess ? imageIndex : fileIndex;
      const filename = `${prefix}_${index}${ext}`;
      const localPath = join(input.attachmentsDir, filename);

      const result = yield* Effect.tryPromise({
        try: () => downloadFile(url, localPath, token),
        catch: () => ({ success: false, isImage: false }),
      });

      if (result.success) {
        const isImage = result.isImage || isImageGuess;
        downloaded.push({ filename, originalUrl: url, localPath, isImage });
        if (isImage) {
          imageIndex += 1;
        } else {
          fileIndex += 1;
        }
      } else {
        failedCount += 1;
      }
    }

    return {
      manifest: buildIncrementalManifest(downloaded, failedCount),
      newImageCount: downloaded.filter((f) => f.isImage).length,
      newFileCount: downloaded.filter((f) => !f.isImage).length,
      failedCount,
    } satisfies IncrementalAttachmentResult;
  }).pipe(
    Effect.catch(() =>
      Effect.succeed({
        manifest: "",
        newImageCount: 0,
        newFileCount: 0,
        failedCount: 0,
      } satisfies IncrementalAttachmentResult),
    ),
  );
