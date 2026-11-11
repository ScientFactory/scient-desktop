import type { EnvironmentHttpApi, ScientSourcesHttpCommandTag } from "@t3tools/contracts";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";

import type { ScientAnnotationsToolkit } from "../annotations/tools.ts";
import type { ScientReferencesToolkit } from "../references/tools.ts";
import type { ScientSystematicReviewsToolkit } from "../systematicReviews/tools.ts";
import type { ScientSourcesToolkit } from "./tools.ts";

export type LibraryToolName =
  | keyof typeof ScientSourcesToolkit.tools
  | keyof typeof ScientReferencesToolkit.tools
  | keyof typeof ScientSystematicReviewsToolkit.tools
  | keyof typeof ScientAnnotationsToolkit.tools;

type EnvironmentGroups =
  typeof EnvironmentHttpApi extends HttpApi.HttpApi<string, infer Groups> ? Groups : never;
type EndpointTag<Group extends string> = Group extends string
  ? `${Group}.${HttpApiEndpoint.Identifier<HttpApiGroup.Endpoints<HttpApiGroup.WithIdentifier<EnvironmentGroups, Group>>>}`
  : never;

/** Every endpoint of these groups is the Library's, except PDF saving, which is the PDF editor's. */
export const LIBRARY_ENDPOINT_GROUPS = ["scientSources", "scientPdf", "scientReferences"] as const;
export const NON_LIBRARY_ENDPOINTS = ["scientPdf.save"] as const;

export type LibraryReadEndpointTag = Exclude<
  EndpointTag<(typeof LIBRARY_ENDPOINT_GROUPS)[number]>,
  ScientSourcesHttpCommandTag | (typeof NON_LIBRARY_ENDPOINTS)[number]
>;

/** `input` names the tool parameter that selects this variant, when the tool does more than this. */
export interface LibraryAgentTool {
  readonly tool: LibraryToolName;
  readonly input?: string;
}

export type LibraryParityEntry =
  | { readonly kind: "tool"; readonly tools: readonly [LibraryAgentTool, ...LibraryAgentTool[]] }
  | { readonly kind: "flow-step"; readonly tool: LibraryToolName; readonly reason: string }
  | { readonly kind: "upload"; readonly tool: LibraryToolName; readonly reason: string }
  | { readonly kind: "display"; readonly reason: string }
  | { readonly kind: "gap"; readonly reason: string };

const tool = (name: LibraryToolName, input?: string): LibraryParityEntry => ({
  kind: "tool",
  tools: [input === undefined ? { tool: name } : { tool: name, input }],
});

/** Every Library change command and the agent tool with the same power. */
export const LIBRARY_COMMAND_PARITY: Record<ScientSourcesHttpCommandTag, LibraryParityEntry> = {
  "scientSources.savePage": tool("scient_sources_save_page"),
  "scientSources.updateMetadata": tool("scient_sources_update"),
  "scientSources.updateNote": tool("scient_sources_note_update"),
  "scientSources.refreshMetadata": tool("scient_sources_check", "refresh"),
  "scientSources.remove": tool("scient_sources_remove"),
  "scientSources.organize": tool("scient_sources_organize"),
  "scientSources.systematicReviewChange": tool("scient_sources_systematic_review_update"),
  "scientSources.bulkUpdate": tool("scient_sources_bulk_update"),
  "scientSources.addByIdentifier": tool("scient_sources_add", "identifierList"),
  "scientSources.restore": tool("scient_sources_restore"),
  "scientSources.deletePermanently": tool("scient_sources_remove", "permanent"),
  "scientSources.revert": tool("scient_sources_revert"),
  "scientSources.localPdfUpload": {
    kind: "upload",
    tool: "scient_sources_add",
    reason: "Sends a dropped PDF's bytes; the tool adds a project PDF by pdfRelativePath.",
  },
  "scientSources.localBeginImport": tool("scient_sources_add", "pdfRelativePath"),
  "scientSources.localDiscard": {
    kind: "flow-step",
    tool: "scient_sources_add",
    reason: "Drops uploaded PDFs the user chose not to add; the tool adds in one call.",
  },
  "scientSources.fileImport": {
    kind: "upload",
    tool: "scient_sources_import_file",
    reason: "Sends a chosen reference file's bytes; the tool imports a project file by path.",
  },
  "scientSources.beginImport": tool("scient_sources_zotero_import", "itemKeys"),
  "scientSources.beginScopedImport": tool("scient_sources_zotero_import", "collectionKey"),
  "scientSources.zoteroRefresh": tool("scient_sources_zotero_refresh"),
  "scientSources.zoteroSend": tool("scient_sources_zotero_send"),
  "scientSources.advanceImport": {
    kind: "flow-step",
    tool: "scient_sources_zotero_import",
    reason: "Moves a running import to its next batch; the tool imports up to 500 in one call.",
  },
  "scientSources.cancelImport": {
    kind: "flow-step",
    tool: "scient_sources_zotero_import",
    reason: "Stops a running import between batches; the tool's call ends on its own.",
  },
  "scientSources.retryImport": {
    kind: "flow-step",
    tool: "scient_sources_zotero_import",
    reason: "Retries failed items of a running import; the tool is called again with itemKeys.",
  },
  "scientSources.syncBibliography": tool("scient_sources_bibliography"),
  "scientPdf.annotationsMutate": {
    kind: "tool",
    tools: [
      { tool: "scient_annotations_add" },
      { tool: "scient_annotations_update" },
      { tool: "scient_annotations_remove" },
      { tool: "scient_annotations_restore", input: "toRevision" },
    ],
  },
  "scientReferences.resolve": tool("scient_references_resolve"),
};

/** Every Library read endpoint and the agent tool that reads the same thing. */
export const LIBRARY_READ_PARITY: Record<LibraryReadEndpointTag, LibraryParityEntry> = {
  "scientSources.overview": {
    kind: "tool",
    tools: [{ tool: "scient_sources_list" }, { tool: "scient_sources_collections" }],
  },
  "scientSources.detail": tool("scient_sources_get"),
  "scientSources.attachmentPreview": {
    kind: "display",
    reason:
      "Serves a PDF's bytes to the viewer; agents read its text with scient_sources_read_text.",
  },
  "scientSources.fullTextSearch": tool("scient_sources_search"),
  "scientSources.journalIcon": { kind: "display", reason: "Serves a journal's icon for display." },
  "scientSources.trash": tool("scient_sources_list", "inTrash"),
  "scientSources.systematicReviews": tool("scient_sources_systematic_reviews"),
  "scientSources.systematicReview": tool("scient_sources_systematic_reviews", "reviewId"),
  "scientSources.revisions": tool("scient_sources_get"),
  "scientSources.zoteroStatus": tool("scient_sources_zotero_browse"),
  "scientSources.zoteroLibrary": tool("scient_sources_zotero_browse"),
  "scientSources.zoteroCollections": tool("scient_sources_zotero_browse"),
  "scientSources.preflight": {
    kind: "flow-step",
    tool: "scient_sources_zotero_import",
    reason: "Shows duplicates before an import; the tool reports them as skipped items.",
  },
  "scientSources.export": tool("scient_sources_export"),
  "scientPdf.annotationsForDocument": tool("scient_annotations_read"),
  "scientPdf.annotationsForSource": tool("scient_annotations_read"),
  "scientReferences.documents": {
    kind: "flow-step",
    tool: "scient_references_check",
    reason: "Lists files the user can pick to check; the tool takes the file's path.",
  },
  "scientReferences.check": tool("scient_references_check"),
};
