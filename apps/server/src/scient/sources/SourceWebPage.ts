// @effect-diagnostics nodeBuiltinImport:off -- Saved pages use the existing synchronous content fingerprint for idempotent keys.
import * as NodeCrypto from "node:crypto";

import {
  noteWithPassage,
  normalizePersistentIdentifier,
  webPageBibliographicTitle,
  webPageCandidate,
  webPageOnlyCandidate,
  webPagePassage,
  type ScientSourceActor,
  type ScientSourceCandidate,
  type ScientSourceWebPage,
} from "@scientfactory/scient-sources";
import {
  listScientSourceRecords,
  readScientSourceRecord,
} from "@scientfactory/scient-sources/store";

import { addAgentSource, updateSourceNote } from "./ScientSourcesCoordinator.ts";
import type { SourceImportObserver } from "./SourceImportObservation.ts";
import { titlesAgree, type ResolveSourceIdentifier } from "./SourceIdentifierResolver.ts";

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
      readonly reason: "identifier-not-found" | "possible-duplicate";
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
 * Saves a browser page to the Library: as the work its identifier names when
 * the registry confirms it and the page's title agrees, otherwise as the web
 * page itself. The selected passage goes into the note with the page it came
 * from, also when the source was already in the Library.
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
  const passage = webPagePassage(input.page.selection, input.page.url);
  const withPassage = async (sourceId: string, outcome: "added" | "existing", revision: number) => {
    const note = passage
      ? await savePassage({ root: input.root, sourceId, passage, actor: input.actor })
      : { revision, saved: false };
    return { outcome, sourceId, revision: note.revision, passageSaved: note.saved };
  };
  const add = (candidate: ScientSourceCandidate, claimedTitle: string | null) =>
    addAgentSource(
      {
        root: input.root,
        candidate,
        enrich: input.enrich ?? candidate.identifiers.length > 0,
        claimedTitle,
        actor: input.actor,
        intake: "web",
        ...(input.resolveIdentifier ? { resolveIdentifier: input.resolveIdentifier } : {}),
      },
      observer,
    );
  const saved = async (
    result: Awaited<ReturnType<typeof add>>,
    claimedTitle: string | null,
  ): Promise<SaveWebPageResult | "not-the-work"> => {
    if (result.outcome === "identifier-mismatch") return "not-the-work";
    if (result.outcome === "identifier-not-found") {
      return {
        outcome: "not-added",
        reason: result.outcome,
        message: result.message,
        matchingSourceIds: [],
      };
    }
    if (result.outcome === "imported" && result.record) {
      return withPassage(result.record.sourceId, "added", result.record.revision);
    }
    const sourceId =
      result.duplicate.kind === "possible-metadata-match"
        ? null
        : result.duplicate.matchingSourceIds[0];
    const existing = sourceId ? await readScientSourceRecord(input.root, sourceId) : null;
    if (!existing) {
      return {
        outcome: "not-added",
        reason: "possible-duplicate",
        message: result.duplicate.reason,
        matchingSourceIds: result.duplicate.matchingSourceIds,
      };
    }
    // An exact duplicate is found by identifier alone, so the title check happens here.
    if (claimedTitle && existing.title && !titlesAgree(claimedTitle, existing.title)) {
      return "not-the-work";
    }
    return withPassage(existing.sourceId, "existing", existing.revision);
  };

  const draft = webPageCandidate(input.page, "pending");
  // Without a title from the page there is nothing to tell the work from a page that cites it.
  const claimedTitle = webPageBibliographicTitle(input.page) ?? (input.page.title?.trim() || null);
  if (draft.identifiers.length > 0 && claimedTitle) {
    const keys = draft.identifiers.map((identifier) =>
      normalizePersistentIdentifier(identifier.scheme, identifier.value),
    );
    const work = await saved(
      await add({ ...draft, sourceKey: pageSourceKey(input.page, keys) }, claimedTitle),
      claimedTitle,
    );
    if (work !== "not-the-work") return work;
  }

  // Without an established work, the page's address is what makes it the same source.
  const address = pageAddress(input.page.url);
  const identified = draft.identifiers.length > 0;
  const existing = (await listScientSourceRecords(input.root)).find(
    (record) =>
      record.url !== null &&
      pageAddress(record.url) === address &&
      (!identified || record.identifiers.length === 0),
  );
  if (existing) return withPassage(existing.sourceId, "existing", existing.revision);
  const page = await saved(
    await add(webPageOnlyCandidate(input.page, pageSourceKey(input.page, [])), null),
    null,
  );
  if (page === "not-the-work") throw new Error("A web page has no identifier to mismatch.");
  return page;
}
