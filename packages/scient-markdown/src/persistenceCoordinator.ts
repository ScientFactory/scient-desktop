import {
  DocumentPersistenceCoordinator,
  type DocumentExternalUpdate,
  type DocumentPersistenceOptions,
  type PrepareDocumentExternalUpdate,
} from "@scientfactory/scient-document";

import { reconcileMarkdown, type MarkdownReconciliation } from "./reconciliation.ts";

export type {
  DocumentPersistenceFailureKind as MarkdownPersistenceFailureKind,
  DocumentPersistenceReadResult as MarkdownPersistenceReadResult,
  DocumentPersistenceSnapshot as MarkdownPersistenceSnapshot,
} from "@scientfactory/scient-document";

export type MarkdownExternalUpdate = DocumentExternalUpdate<MarkdownReconciliation>;
export type PrepareMarkdownExternalUpdate = PrepareDocumentExternalUpdate<MarkdownReconciliation>;
export type MarkdownPersistenceOptions = Omit<
  DocumentPersistenceOptions<MarkdownReconciliation>,
  "reconcile"
>;

/** The document persistence coordinator with Markdown's block-level reconciliation. */
export class MarkdownPersistenceCoordinator extends DocumentPersistenceCoordinator<MarkdownReconciliation> {
  constructor(options: MarkdownPersistenceOptions) {
    super({ ...options, reconcile: reconcileMarkdown });
  }
}
