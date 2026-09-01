export type MarkdownDocumentMode = "read" | "write";

export interface MarkdownExternalConflict {
  readonly externalSource: string;
  readonly externalRevision: string;
}

export interface MarkdownDocumentSession {
  readonly mode: MarkdownDocumentMode;
  readonly baselineSource: string;
  readonly baselineRevision: string;
  readonly draftSource: string;
  readonly editVersion: number;
  readonly confirmedEditVersion: number;
  readonly conflict: MarkdownExternalConflict | null;
}

export interface MarkdownSaveIntent {
  readonly source: string;
  readonly expectedRevision: string;
  readonly editVersion: number;
}

export function createMarkdownDocumentSession(input: {
  readonly source: string;
  readonly revision: string;
  readonly draftSource?: string;
  readonly mode?: MarkdownDocumentMode;
}): MarkdownDocumentSession {
  const draftSource = input.draftSource ?? input.source;
  const editVersion = draftSource === input.source ? 0 : 1;
  return {
    mode: input.mode ?? "read",
    baselineSource: input.source,
    baselineRevision: input.revision,
    draftSource,
    editVersion,
    confirmedEditVersion: 0,
    conflict: null,
  };
}

/** Mode is presentation state. It cannot create a document edit or save intent. */
export function setMarkdownDocumentMode(
  session: MarkdownDocumentSession,
  mode: MarkdownDocumentMode,
): MarkdownDocumentSession {
  return session.mode === mode ? session : { ...session, mode };
}

/** Apply only source produced by an explicit user-authored document transaction. */
export function applyUserMarkdownSource(
  session: MarkdownDocumentSession,
  source: string,
): MarkdownDocumentSession {
  if (source === session.draftSource) return session;
  return {
    ...session,
    draftSource: source,
    editVersion: session.editVersion + 1,
  };
}

export function beginMarkdownSave(session: MarkdownDocumentSession): MarkdownSaveIntent | null {
  if (session.conflict !== null || session.draftSource === session.baselineSource) return null;
  return {
    source: session.draftSource,
    expectedRevision: session.baselineRevision,
    editVersion: session.editVersion,
  };
}

/**
 * Confirm exactly the snapshot sent to disk. Newer keystrokes remain dirty and
 * will produce another intent against the returned revision.
 */
export function confirmMarkdownSave(
  session: MarkdownDocumentSession,
  intent: MarkdownSaveIntent,
  revision: string,
): MarkdownDocumentSession {
  if (intent.expectedRevision !== session.baselineRevision) return session;
  if (intent.editVersion <= session.confirmedEditVersion) return session;
  return {
    ...session,
    baselineSource: intent.source,
    baselineRevision: revision,
    confirmedEditVersion: intent.editVersion,
    // A later observed external write is not undone by an older command's
    // acknowledgement. Keep the explicit conflict until the user resolves it.
    conflict: session.conflict?.externalSource === intent.source ? null : session.conflict,
  };
}

/** Receive a read/refresh from disk without misclassifying it as user authorship. */
export function receiveExternalMarkdownSource(
  session: MarkdownDocumentSession,
  input: { readonly source: string; readonly revision: string },
): MarkdownDocumentSession {
  const locallyDirty = session.draftSource !== session.baselineSource;
  if (!locallyDirty || input.source === session.draftSource) {
    return {
      ...session,
      baselineSource: input.source,
      baselineRevision: input.revision,
      draftSource: input.source,
      confirmedEditVersion: session.editVersion,
      conflict: null,
    };
  }
  if (input.source === session.baselineSource) {
    return { ...session, baselineRevision: input.revision };
  }
  return {
    ...session,
    conflict: { externalSource: input.source, externalRevision: input.revision },
  };
}

export function resolveMarkdownConflictWithDisk(
  session: MarkdownDocumentSession,
): MarkdownDocumentSession {
  if (session.conflict === null) return session;
  return {
    ...session,
    baselineSource: session.conflict.externalSource,
    baselineRevision: session.conflict.externalRevision,
    draftSource: session.conflict.externalSource,
    confirmedEditVersion: session.editVersion,
    conflict: null,
  };
}

/** Keep the local draft, but retry it against the externally observed revision. */
export function resolveMarkdownConflictWithLocal(
  session: MarkdownDocumentSession,
): MarkdownDocumentSession {
  if (session.conflict === null) return session;
  return rebaseLocalMarkdownDraft(session, {
    source: session.conflict.externalSource,
    revision: session.conflict.externalRevision,
  });
}

/**
 * Keep the current local draft while adopting one complete authoritative disk
 * snapshot as its compare-and-swap baseline. This is also valid when the host
 * learned about the snapshot from a rejected write before the session's
 * external-source effect observed it.
 */
export function rebaseLocalMarkdownDraft(
  session: MarkdownDocumentSession,
  input: { readonly source: string; readonly revision: string },
): MarkdownDocumentSession {
  return {
    ...session,
    baselineSource: input.source,
    baselineRevision: input.revision,
    conflict: null,
  };
}
