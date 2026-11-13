// @effect-diagnostics nodeBuiltinImport:off -- Source keys and operation IDs use synchronous Node hashing like other Sources adds.
import * as NodeCrypto from "node:crypto";

import {
  detectSourceIdentifier,
  normalizePersistentIdentifier,
  type ScientSourceActor,
  type ScientSourceCandidate,
  type ScientSourceIdentifier,
  type ScientSourceIdentifierAddItem,
  type ScientSourceRecord,
  sourceIdentifierLabel,
  sourceIdentifierRegistryName,
} from "@scientfactory/scient-sources";
import type { ScientSourceStoreLocation } from "@scientfactory/scient-sources/library-root";
import { importScientSource, listScientSourceRecords } from "@scientfactory/scient-sources/store";
import * as Context from "effect/Context";

import { observeSourceImport, type SourceImportObserver } from "./SourceImportObservation.ts";
import { scheduleSourceCategorization, seedSourceCategories } from "./SourceCategories.ts";
import { enrichScientSourceCandidate } from "./SourceMetadataEnricher.ts";
import {
  applyResolvedSourceMetadata,
  resolveSourceIdentifierBatch,
  type ResearchKeys,
  type SourceIdentifierResolution,
} from "./SourceIdentifierResolver.ts";

export type ResolveSourceIdentifierBatch = (
  identifiers: ReadonlyArray<ScientSourceIdentifier>,
  keys?: ResearchKeys,
) => Promise<ReadonlyArray<SourceIdentifierResolution>>;

const ENRICH_PARALLEL = 4;

function identifierKey(identifier: ScientSourceIdentifier): string {
  return normalizePersistentIdentifier(identifier.scheme, identifier.value);
}

function identifierOnlyCandidate(
  identifier: ScientSourceIdentifier,
  actor: ScientSourceActor,
): ScientSourceCandidate {
  return {
    sourceKey: `identifier_${NodeCrypto.createHash("sha256").update(identifierKey(identifier)).digest("hex")}`,
    type: identifier.scheme === "isbn" ? "book" : "other",
    customType: null,
    title: null,
    creators: [],
    issuedRaw: null,
    issuedYear: null,
    identifiers: [identifier],
    abstract: null,
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [],
    externalReferences: [],
    fieldProvenance: [{ field: "identifiers", origin: actor, sourceField: null }],
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
}

type Step =
  | { readonly kind: "done"; readonly item: ScientSourceIdentifierAddItem }
  | {
      readonly kind: "resolve";
      readonly input: string;
      readonly identifier: ScientSourceIdentifier;
    };

function existingItem(
  input: string,
  identifier: ScientSourceIdentifier,
  record: ScientSourceRecord | undefined,
  possible: boolean,
): ScientSourceIdentifierAddItem {
  return {
    input,
    identifier,
    outcome: "duplicate",
    sourceId: record?.sourceId ?? null,
    title: record?.title ?? null,
    ...(record?.verification ? { verification: record.verification.state } : {}),
    ...(possible ? { possibleMatch: true as const } : {}),
    message: possible
      ? "A source with the same title, first author and year is already in the Library."
      : "Already in the Library.",
  };
}

/**
 * Adds one source per DOI, PMID, arXiv ID or ISBN. Each identifier is resolved first; only
 * a found identifier is added, with its registry metadata, as verified. Entries that are
 * not identifiers, do not exist, or cannot be checked right now are reported, not added.
 */
export async function addScientSourcesByIdentifier(
  input: {
    readonly root: ScientSourceStoreLocation;
    readonly entries: ReadonlyArray<string>;
    readonly actor: ScientSourceActor;
    readonly enrich?: boolean;
    readonly allowPossibleMetadataMatch?: boolean;
    readonly resolveIdentifiers?: ResolveSourceIdentifierBatch;
  },
  observer?: SourceImportObserver,
): Promise<ReadonlyArray<ScientSourceIdentifierAddItem>> {
  const firstByKey = new Map<string, number>();
  const steps = input.entries.map(
    (
      entry,
      index,
    ): Step | { readonly kind: "repeat"; readonly of: number; readonly input: string } => {
      const text = entry.trim();
      const identifier = detectSourceIdentifier(text);
      if (!identifier) {
        return {
          kind: "done",
          item: {
            input: text,
            identifier: null,
            outcome: "unrecognized",
            sourceId: null,
            title: null,
            message: "Not a DOI, PMID, arXiv ID or ISBN.",
          },
        };
      }
      const key = identifierKey(identifier);
      const first = firstByKey.get(key);
      if (first !== undefined) return { kind: "repeat", of: first, input: text };
      firstByKey.set(key, index);
      // A bare identifier has no title to corroborate a stored record, so its registry answers first.
      return { kind: "resolve", input: text, identifier };
    },
  );

  const toResolve = steps.flatMap((step) => (step.kind === "resolve" ? [step] : []));
  const resolutions = await (input.resolveIdentifiers ?? resolveSourceIdentifierBatch)(
    toResolve.map((step) => step.identifier),
  );
  const resolutionByKey = new Map(
    toResolve.map((step, index) => [identifierKey(step.identifier), resolutions[index]]),
  );

  const found = toResolve.flatMap((step) => {
    const resolution = resolutionByKey.get(identifierKey(step.identifier));
    return resolution?.status === "found"
      ? [
          {
            step,
            candidate: applyResolvedSourceMetadata(
              identifierOnlyCandidate(step.identifier, input.actor),
              resolution,
            ),
            resolution,
          },
        ]
      : [];
  });
  const enriched = new Map<string, ScientSourceCandidate>();
  for (let start = 0; start < found.length; start += ENRICH_PARALLEL) {
    const batch = found.slice(start, start + ENRICH_PARALLEL);
    const candidates = await Promise.all(
      batch.map(({ candidate }) =>
        input.enrich ? enrichScientSourceCandidate(candidate).catch(() => candidate) : candidate,
      ),
    );
    batch.forEach(({ step }, index) => {
      const candidate = candidates[index];
      if (candidate) enriched.set(identifierKey(step.identifier), candidate);
    });
  }

  const operationId = `${input.actor}_${NodeCrypto.randomUUID()}`;
  const results: Array<ScientSourceIdentifierAddItem> = [];
  for (const step of steps) {
    if (step.kind === "done") {
      results.push(step.item);
      continue;
    }
    if (step.kind === "repeat") {
      const first = results[step.of];
      if (first) {
        results.push(
          first.outcome === "imported"
            ? {
                ...first,
                input: step.input,
                outcome: "duplicate",
                message: "Listed twice; added once.",
              }
            : { ...first, input: step.input },
        );
      }
      continue;
    }
    const key = identifierKey(step.identifier);
    const resolution = resolutionByKey.get(key);
    if (resolution?.status !== "found") {
      const missing =
        (resolution?.status === "not-found" ? resolution.named : undefined) ?? step.identifier;
      const registry = sourceIdentifierRegistryName(missing);
      results.push({
        input: step.input,
        identifier: step.identifier,
        outcome: resolution?.status === "not-found" ? "identifier-not-found" : "unavailable",
        sourceId: null,
        title: null,
        message:
          resolution?.status === "not-found"
            ? `The ${sourceIdentifierLabel(missing)} does not exist at ${registry}.`
            : `${registry} could not be reached, so nothing was added. Try again later.`,
      });
      continue;
    }
    const candidate =
      enriched.get(key) ??
      applyResolvedSourceMetadata(
        identifierOnlyCandidate(step.identifier, input.actor),
        resolution,
      );
    const imported = await observeSourceImport(
      observer,
      () =>
        importScientSource({
          root: input.root,
          operationId,
          candidate,
          actor: input.actor,
          intake: "identifier",
          // A work only a catalogue has is not registry-verified.
          verification: resolution.catalogueOnly
            ? { state: "unverified" }
            : {
                state: "verified",
                identifier: resolution.identifier,
                checkedAt: resolution.retrievedAt,
              },
          allowPossibleMetadataMatch: input.allowPossibleMetadataMatch ?? false,
        }),
      (result) => (result.outcome === "imported" ? "imported" : "skipped"),
    );
    if (imported.outcome === "imported" && imported.record) {
      seedSourceCategories(input.root, imported.record.sourceId, resolution.metadata.topics);
      results.push({
        input: step.input,
        identifier: step.identifier,
        outcome: "imported",
        sourceId: imported.record.sourceId,
        title: imported.record.title,
        verification: resolution.catalogueOnly ? "unverified" : "verified",
        message: null,
      });
      continue;
    }
    const matching = imported.duplicate.matchingSourceIds[0];
    const record = matching
      ? (await listScientSourceRecords(input.root)).find((entry) => entry.sourceId === matching)
      : undefined;
    results.push(
      existingItem(
        step.input,
        step.identifier,
        record,
        imported.duplicate.kind === "possible-metadata-match",
      ),
    );
  }
  if (results.some((item) => item.outcome === "imported")) {
    void scheduleSourceCategorization(input.root);
  }
  return results;
}

export const SourceIdentifierBatchLookup = Context.Reference<ResolveSourceIdentifierBatch>(
  "scient/sources/SourceIdentifierBatchLookup",
  {
    defaultValue: () => (identifiers, keys) =>
      resolveSourceIdentifierBatch(identifiers, keys ? { keys } : {}),
  },
);

/** "Added 2 of 4. 1 already in the Library. 1 not found.", for people and agents. */
export function summarizeIdentifierAdd(
  results: ReadonlyArray<ScientSourceIdentifierAddItem>,
): string {
  const count = (outcome: ScientSourceIdentifierAddItem["outcome"]) =>
    results.filter((item) => item.outcome === outcome).length;
  const parts = [
    `Added ${count("imported")} of ${results.length}.`,
    ...(
      [
        ["duplicate", "already in the Library"],
        ["identifier-not-found", "not found"],
        ["unavailable", "could not be checked now"],
        ["unrecognized", "not an identifier"],
      ] as const
    ).flatMap(([outcome, label]) => {
      const total = count(outcome);
      return total > 0 ? [`${total} ${label}.`] : [];
    }),
  ];
  return parts.join(" ");
}
