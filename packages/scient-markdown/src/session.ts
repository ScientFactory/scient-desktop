/** Markdown names for the format-neutral session in `@scientfactory/scient-document`. */
export {
  applyUserDocumentSource as applyUserMarkdownSource,
  beginDocumentSave as beginMarkdownSave,
  confirmDocumentSave as confirmMarkdownSave,
  createDocumentSession as createMarkdownDocumentSession,
  rebaseLocalDocumentDraft as rebaseLocalMarkdownDraft,
  receiveExternalDocumentSource as receiveExternalMarkdownSource,
  resolveDocumentConflictWithDisk as resolveMarkdownConflictWithDisk,
  resolveDocumentConflictWithLocal as resolveMarkdownConflictWithLocal,
  setDocumentMode as setMarkdownDocumentMode,
  type DocumentExternalConflict as MarkdownExternalConflict,
  type DocumentMode as MarkdownDocumentMode,
  type DocumentSaveIntent as MarkdownSaveIntent,
  type DocumentSession as MarkdownDocumentSession,
} from "@scientfactory/scient-document";
