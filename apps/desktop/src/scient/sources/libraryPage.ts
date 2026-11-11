import {
  DesktopPreviewLibraryPageSchema,
  DesktopPreviewTabInputSchema,
  type DesktopPreviewLibraryPage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../../ipc/DesktopIpc.ts";
import { PREVIEW_LIBRARY_PAGE_CHANNEL } from "../../ipc/channels.ts";
import * as PreviewManager from "../../preview/Manager.ts";

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const PDF_MEDIA_TYPES = new Set(["application/pdf", "application/x-pdf"]);

/** Runs in the page: what it says about itself, bounded before it crosses the process boundary. */
const LIBRARY_PAGE_SCRIPT = `(() => {
  const meta = [];
  for (const element of document.querySelectorAll("meta[name], meta[property]")) {
    if (meta.length >= 400) break;
    const name = (element.getAttribute("name") || element.getAttribute("property") || "").slice(0, 200);
    const content = (element.getAttribute("content") || "").slice(0, 4000);
    if (name && content) meta.push({ name, content });
  }
  const selection = String(window.getSelection ? window.getSelection() : "").slice(0, 20000);
  return {
    title: String(document.title || "").slice(0, 2000) || null,
    selection: selection.trim() ? selection : null,
    meta,
    contentType: String(document.contentType || ""),
  };
})()`;

const PageReport = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  selection: Schema.NullOr(Schema.String),
  meta: Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.String })),
  contentType: Schema.String,
});
const decodePageReport = Schema.decodeUnknownOption(PageReport);
const decodeLibraryPage = Schema.decodeUnknownOption(DesktopPreviewLibraryPageSchema);

/** A save-as name for a PDF address: its last path segment, or a plain default. */
export function libraryPdfFileName(url: string): string {
  let segment = "";
  try {
    segment = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
  } catch {
    segment = "";
  }
  const stem = segment
    .replace(/[\\/\x00]/gu, "_")
    .replace(/\.pdf$/iu, "")
    .trim()
    .slice(0, 200);
  return `${stem || "document"}.pdf`;
}

const isPdf = (bytes: Uint8Array) =>
  bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";

/** A PDF response's bytes, read within the size budget; null as soon as it is not a PDF or too large. */
async function readPdfResponse(response: Response): Promise<Uint8Array | null> {
  const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (
    !response.ok ||
    !response.body ||
    !PDF_MEDIA_TYPES.has(mediaType.toLowerCase()) ||
    declared > MAX_PDF_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_PDF_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return isPdf(bytes) ? bytes : null;
}

/**
 * Reads a tab for "Save to Library". The address comes from the tab, never
 * from the page; a PDF is fetched again through the tab's own session, so a
 * signed-in copy stays signed in.
 */
export const readLibraryPage = Effect.fn("scient.sources.readLibraryPage")(function* (
  tabId: string,
): Effect.fn.Return<DesktopPreviewLibraryPage | null, never, PreviewManager.PreviewManager> {
  const manager = yield* PreviewManager.PreviewManager;
  const contents = yield* manager.accountsWebContents(tabId).pipe(Effect.option);
  if (Option.isNone(contents) || contents.value.isDestroyed()) return null;
  const tab = contents.value;
  const url = tab.getURL();
  if (!/^https?:\/\//iu.test(url) || url.length > 4_096) return null;
  const report = decodePageReport(
    yield* Effect.tryPromise({
      try: () => tab.executeJavaScript(LIBRARY_PAGE_SCRIPT),
      catch: () => "unreadable" as const,
    }).pipe(Effect.orElseSucceed(() => null)),
  );
  if (Option.isNone(report)) return null;
  if (report.value.contentType === "application/pdf") {
    const data = yield* Effect.tryPromise({
      try: async (signal) => readPdfResponse(await tab.session.fetch(url, { signal })),
      catch: () => "unreadable" as const,
    }).pipe(
      Effect.timeout("2 minutes"),
      Effect.orElseSucceed(() => null),
    );
    if (!data) return null;
    return Option.getOrNull(
      decodeLibraryPage({ _tag: "pdf", url, fileName: libraryPdfFileName(url), data }),
    );
  }
  return Option.getOrNull(
    decodeLibraryPage({
      _tag: "page",
      page: {
        url,
        title: report.value.title?.slice(0, 2_000) ?? null,
        selection: report.value.selection?.slice(0, 20_000) ?? null,
        meta: report.value.meta.slice(0, 400).map(({ name, content }) => ({
          name: name.slice(0, 200),
          content: content.slice(0, 4_000),
        })),
      },
    }),
  );
});

export const readLibraryPageMethod = DesktopIpc.makeIpcMethod({
  channel: PREVIEW_LIBRARY_PAGE_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.NullOr(DesktopPreviewLibraryPageSchema),
  handler: Effect.fn("desktop.ipc.preview.readLibraryPage")(function* ({ tabId }) {
    return yield* readLibraryPage(tabId);
  }),
});
