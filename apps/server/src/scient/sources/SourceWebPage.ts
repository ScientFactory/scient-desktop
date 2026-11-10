// @effect-diagnostics nodeBuiltinImport:off -- Saved pages use the existing synchronous content fingerprint for idempotent keys.
import * as NodeCrypto from "node:crypto";

import {
  noteWithPassage,
  normalizePersistentIdentifier,
  webPageCandidate,
  webPagePassage,
  type ScientSourceActor,
  type ScientSourceWebPage,
} from "@scientfactory/scient-sources";
import {
  listScientSourceRecords,
  readScientSourceRecord,
} from "@scientfactory/scient-sources/store";

import { addAgentSource, updateSourceNote } from "./ScientSourcesCoordinator.ts";
import type { SourceImportObserver } from "./SourceImportObservation.ts";
import type { ResolveSourceIdentifier } from "./SourceIdentifierResolver.ts";

export type SaveWebPageResult =
  | {
      readonly outcome: "added" | "existing";
      readonly sourceId: string;
      readonly revision: number;
      /** The selected passage was added to the source's note. */
      readonly passageSaved: boolean;
    }
  | {
      readonly outcome: "not-added";
      readonly reason: "identifier-not-found" | "identifier-mismatch" | "possible-duplicate";
      readonly message: string;
      readonly matchingSourceIds: ReadonlyArray<string>;
    };

const NOTE_ATTEMPTS = 3;

function pageAddress(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    return parsed.href.replace(/\/$/u, "");
  } catch {
    return url.trim();
  }
}

function pageSourceKey(page: ScientSourceWebPage, identifiers: ReadonlyArray<string>): string {
  const identity = identifiers.length > 0 ? identifiers.join("\0") : page.url.trim();
  return `web_${NodeCrypto.createHash("sha256").update(identity).digest("hex")}`;
}

/** Adds the passage to the note of whatever revision the source has now. */
async function savePassage(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly passage: string;
  readonly actor: ScientSourceActor;
}): Promise<{ readonly revision: number; readonly saved: boolean }> {
  for (let attempt = 0; attempt < NOTE_ATTEMPTS; attempt += 1) {
    const record = await readScientSourceRecord(input.root, input.sourceId);
    if (!record) break;
    const note = noteWithPassage(record.note, input.passage);
    if (note === null) return { revision: record.revision, saved: false };
    const result = await updateSourceNote({
      root: input.root,
      sourceId: input.sourceId,
      expectedRevision: record.revision,
      note,
      actor: input.actor,
    });
    if (result.outcome !== "stale") return { revision: result.record.revision, saved: true };
  }
  throw new Error("The source kept changing, so the selected passage was not saved.");
}

/**
 * Saves a browser page to the Library: by the identifier the page states,
 * checked against its registry, or as a web page. The selected passage goes
 * into the note, also when the source was already in the Library.
 */
export async function saveWebPageSource(
  input: {
    readonly root: string;
    readonly page: ScientSourceWebPage;
    readonly actor: ScientSourceActor;
    readonly resolveIdentifier?: ResolveSourceIdentifier;
    /** Look up a missing abstract after the registry; on by default for identified works. */
    readonly enrich?: boolean;
  },
  observer?: SourceImportObserver,
): Promise<SaveWebPageResult> {
  const draft = webPageCandidate(input.page, "pending");
  const keys = draft.identifiers.map((identifier) =>
    normalizePersistentIdentifier(identifier.scheme, identifier.value),
  );
  const candidate = { ...draft, sourceKey: pageSourceKey(input.page, keys) };
  const passage = webPagePassage(input.page.selection);
  const withPassage = async (sourceId: string, outcome: "added" | "existing", revision: number) => {
    const note = passage
      ? await savePassage({ root: input.root, sourceId, passage, actor: input.actor })
      : { revision, saved: false };
    return { outcome, sourceId, revision: note.revision, passageSaved: note.saved };
  };
  if (candidate.identifiers.length === 0) {
    // Without an identifier, the page's address is what makes it the same source.
    const address = pageAddress(input.page.url);
    const existing = (await listScientSourceRecords(input.root)).find(
      (record) => record.url !== null && pageAddress(record.url) === address,
    );
    if (existing) return withPassage(existing.sourceId, "existing", existing.revision);
  }
  const result = await addAgentSource(
    {
      root: input.root,
      candidate,
      enrich: input.enrich ?? candidate.identifiers.length > 0,
      // The page title is the site's, not a claim about the work the identifier names.
      claimedTitle: null,
      actor: input.actor,
      intake: "web",
      ...(input.resolveIdentifier ? { resolveIdentifier: input.resolveIdentifier } : {}),
    },
    observer,
  );
  if (result.outcome === "identifier-not-found" || result.outcome === "identifier-mismatch") {
    return {
      outcome: "not-added",
      reason: result.outcome,
      message: result.message,
      matchingSourceIds: [],
    };
  }
  const added = result.outcome === "imported" ? result.record : null;
  const sourceId =
    added?.sourceId ??
    (result.duplicate.kind === "possible-metadata-match"
      ? null
      : result.duplicate.matchingSourceIds[0]);
  if (!sourceId) {
    return {
      outcome: "not-added",
      reason: "possible-duplicate",
      message: result.duplicate.reason,
      matchingSourceIds: result.duplicate.matchingSourceIds,
    };
  }
  const revision =
    added?.revision ?? (await readScientSourceRecord(input.root, sourceId))?.revision ?? 1;
  return withPassage(sourceId, added ? "added" : "existing", revision);
}
