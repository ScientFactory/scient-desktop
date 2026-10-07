export {
  applyMarkdownSourcePatches,
  createMarkdownSourceLedger,
  replaceMarkdownSourceBlocks,
  type MarkdownSourceBlock,
  type MarkdownSourceBlockReplacement,
  type MarkdownSourceLedger,
  type MarkdownSourcePatch,
  type MarkdownSourceTextSpan,
} from "./sourceLedger.ts";
export {
  applyUserMarkdownSource,
  beginMarkdownSave,
  confirmMarkdownSave,
  createMarkdownDocumentSession,
  receiveExternalMarkdownSource,
  rebaseLocalMarkdownDraft,
  resolveMarkdownConflictWithDisk,
  resolveMarkdownConflictWithLocal,
  setMarkdownDocumentMode,
  type MarkdownDocumentMode,
  type MarkdownDocumentSession,
  type MarkdownExternalConflict,
  type MarkdownSaveIntent,
} from "./session.ts";
export {
  MarkdownPersistenceCoordinator,
  type MarkdownPersistenceFailureKind,
  type MarkdownPersistenceOptions,
  type MarkdownPersistenceReadResult,
  type MarkdownPersistenceSnapshot,
  type MarkdownExternalUpdate,
  type PrepareMarkdownExternalUpdate,
} from "./persistenceCoordinator.ts";
export { reconcileMarkdown, type MarkdownReconciliation } from "./reconciliation.ts";
export {
  MARKDOWN_FRONT_MATTER_EXTENSIONS,
  inspectMarkdownDocument,
  markdownProseTextSpans,
  mermaidSourcesInMarkdown,
  rewriteMarkdownImageDestinations,
  resolveMarkdownDocumentRelativePath,
  type MarkdownDocumentInspection,
} from "./documentResources.ts";
