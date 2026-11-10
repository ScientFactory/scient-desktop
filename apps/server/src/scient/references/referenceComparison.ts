import type {
  ScientReferenceBibtexField,
  ScientReferenceFindingKind,
  ScientReferenceSourceField,
  ScientSourceIdentifier,
} from "@scientfactory/scient-sources";

import {
  creatorDisplayName,
  titlesAgree,
  type ResolvedSourceMetadata,
} from "../sources/SourceIdentifierResolver.ts";

/** What a reference claims about its work, in comparable form. */
export interface ClaimedReference {
  readonly title: string | null;
  readonly firstAuthor: string | null;
  readonly year: number | null;
  readonly container: string | null;
  readonly volume: string | null;
  readonly pages: string | null;
  /** Free reference text (bibitem or typed list), compared by words instead of fields. */
  readonly raw: string | null;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
}

export type ComparableField = "title" | "year" | "container" | "volume" | "pages" | "publisher";

/** A finding before it is placed: the engine adds identity, location and the concrete fix. */
export interface FindingDraft {
  readonly kind: ScientReferenceFindingKind;
  readonly message: string;
  readonly detail: string;
  readonly related?: { readonly label: string; readonly url: string };
  readonly fix?: { readonly field: ComparableField; readonly value: string };
}

export const BIBTEX_FIELD_FOR: Readonly<
  Record<ComparableField, ReadonlyArray<ScientReferenceBibtexField>>
> = {
  title: ["title"],
  year: ["year"],
  container: ["journal", "journaltitle", "booktitle"],
  volume: ["volume"],
  pages: ["pages"],
  publisher: ["publisher"],
};

export const SOURCE_FIELD_FOR: Readonly<Record<ComparableField, ScientReferenceSourceField>> = {
  title: "title",
  year: "issuedYear",
  container: "containerTitle",
  volume: "volume",
  pages: "pages",
  publisher: "publisher",
};

const words = (value: string): ReadonlyArray<string> =>
  value
    .replace(/<[^>]*>/gu, " ")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const comparable = (value: string) => words(value).join(" ");

const withoutRetractionPrefix = (title: string) =>
  title.replace(/^\s*(?:retracted(?:\s+article)?|withdrawn)\s*[:.-]\s*/iu, "");

function familyName(metadata: ResolvedSourceMetadata): string | null {
  const first = metadata.creators[0];
  if (!first) return null;
  return first.familyName ?? first.literalName ?? null;
}

function sameFamilyName(left: string, right: string): boolean {
  const a = words(left);
  const b = words(right);
  if (a.length === 0 || b.length === 0) return true;
  return a.at(-1) === b.at(-1) || a.includes(b.at(-1)!) || b.includes(a.at(-1)!);
}

const VENUE_FILLER = new Set([
  "of",
  "the",
  "and",
  "in",
  "on",
  "for",
  "proceedings",
  "conference",
  "journal",
]);

/** Venues agree when one names the other, including abbreviations such as "J Sleep Res". */
function venuesAgree(left: string, right: string): boolean {
  const allLeft = words(left);
  const allRight = words(right);
  const a = allLeft.filter((word) => !VENUE_FILLER.has(word));
  const b = allRight.filter((word) => !VENUE_FILLER.has(word));
  if (a.length === 0 || b.length === 0) return true;
  const contains = (xs: ReadonlyArray<string>, ys: ReadonlyArray<string>) =>
    xs.every((x) => ys.includes(x));
  const abbreviates = (xs: ReadonlyArray<string>, ys: ReadonlyArray<string>) =>
    xs.every((x) => ys.some((y) => y.startsWith(x)));
  return contains(a, b) || contains(b, a) || abbreviates(a, allRight) || abbreviates(b, allLeft);
}

const firstPage = (pages: string) =>
  pages
    .split(/[-–—]+/u)[0]!
    .trim()
    .replace(/^e/iu, "")
    .toLowerCase();

const isArxivDoi = (identifier: ScientSourceIdentifier) =>
  identifier.scheme === "doi" && identifier.value.toLowerCase().startsWith("10.48550/arxiv.");

export function identifierLabel(identifier: ScientSourceIdentifier): string {
  switch (identifier.scheme) {
    case "doi":
      return `DOI ${identifier.value}`;
    case "pmid":
      return `PMID ${identifier.value}`;
    case "arxiv":
      return `arXiv ${identifier.value}`;
    default:
      return `${identifier.scheme.toUpperCase()} ${identifier.value}`;
  }
}

export function registryName(identifier: ScientSourceIdentifier): string {
  return identifier.scheme === "pmid" ? "PubMed" : "doi.org";
}

export function registryCitation(metadata: ResolvedSourceMetadata): string {
  const author = familyName(metadata);
  const parts = [author, metadata.issuedYear === null ? null : String(metadata.issuedYear)].filter(
    (part): part is string => Boolean(part),
  );
  return `“${metadata.title ?? "Untitled"}”${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

export function registryCreators(metadata: ResolvedSourceMetadata): ReadonlyArray<string> {
  return metadata.creators.slice(0, 3).flatMap((creator) => {
    const name = creatorDisplayName(creator);
    return name ? [name] : [];
  });
}

/**
 * Whether the registry record is a different work from the one the reference describes.
 * Free text counts as the same work when most of the registry title's words appear in it.
 */
export function describesDifferentWork(
  claimed: ClaimedReference,
  metadata: ResolvedSourceMetadata,
): boolean {
  const resolvedTitle = metadata.title ? withoutRetractionPrefix(metadata.title) : null;
  if (!resolvedTitle) return false;
  if (claimed.title) return !titlesAgree(claimed.title, resolvedTitle);
  if (!claimed.raw) return false;
  const titleWords = new Set(words(resolvedTitle));
  const rawWords = new Set(words(claimed.raw));
  const shared = [...titleWords].filter((word) => rawWords.has(word)).length;
  return titleWords.size > 0 && shared / titleWords.size < 0.6;
}

const RETRACTION_TYPES = new Set(["retraction", "withdrawal", "removal"]);
const NOTICE_LABELS: Readonly<Record<string, string>> = {
  correction: "a correction",
  erratum: "an erratum",
  corrigendum: "a corrigendum",
  addendum: "an addendum",
  expression_of_concern: "an expression of concern",
  "expression-of-concern": "an expression of concern",
};

const doiUrl = (doi: string) => `https://doi.org/${doi}`;

/** Retractions, corrections and published versions the registry links to the work. */
export function registryStatusFindings(
  claimed: ClaimedReference,
  metadata: ResolvedSourceMetadata,
): ReadonlyArray<FindingDraft> {
  const drafts: Array<FindingDraft> = [];
  const updates = metadata.updates ?? [];
  const retraction = updates.find((update) => RETRACTION_TYPES.has(update.type));
  if (retraction || /^\s*(?:retracted|withdrawn)\b/iu.test(metadata.title ?? "")) {
    drafts.push({
      kind: "retracted",
      message: `This work has been retracted${retraction?.date ? ` (${retraction.date})` : ""}. Do not rest a claim on it.`,
      detail: retraction?.doi ?? "title",
      ...(retraction?.doi
        ? { related: { label: "Retraction notice", url: doiUrl(retraction.doi) } }
        : {}),
    });
  }
  const seen = new Set<string>();
  for (const update of updates) {
    const label = NOTICE_LABELS[update.type];
    if (!label || seen.has(update.type)) continue;
    seen.add(update.type);
    drafts.push({
      kind: "editorial-notice",
      message: `The registry lists ${label} to this work${update.date ? ` (${update.date})` : ""}. Check whether it changes what you cite.`,
      detail: update.doi ?? update.type,
      ...(update.doi ? { related: { label: "Notice", url: doiUrl(update.doi) } } : {}),
    });
  }
  const cited = new Set(
    claimed.identifiers
      .filter((identifier) => identifier.scheme === "doi")
      .map((identifier) => identifier.value.toLowerCase()),
  );
  const published = (metadata.relations ?? []).find(
    (relation) =>
      relation.type === "is-preprint-of" &&
      (relation.idType === null || relation.idType === "doi") &&
      !cited.has(relation.id.toLowerCase()),
  );
  if (published) {
    drafts.push({
      kind: "published-version",
      message:
        "This is a preprint. A peer-reviewed version has been published; consider citing it.",
      detail: published.id.toLowerCase(),
      related: { label: "Published version", url: doiUrl(published.id) },
    });
  }
  return drafts;
}

/** Field-by-field differences between the reference and its registry record. */
export function detailFindings(
  claimed: ClaimedReference,
  metadata: ResolvedSourceMetadata,
  resolvedIdentifier: ScientSourceIdentifier,
): ReadonlyArray<FindingDraft> {
  const drafts: Array<FindingDraft> = [];
  // An arXiv record knows the preprint, not the venue or year a published version has.
  const preprintRecord =
    isArxivDoi(resolvedIdentifier) &&
    claimed.container !== null &&
    !/arxiv/iu.test(claimed.container);
  const resolvedTitle = metadata.title ? withoutRetractionPrefix(metadata.title) : null;
  if (claimed.title && resolvedTitle && comparable(claimed.title) !== comparable(resolvedTitle)) {
    drafts.push({
      kind: "details-differ",
      message: `The title differs from the registry's: “${resolvedTitle}”.`,
      detail: `title:${resolvedTitle}`,
      fix: { field: "title", value: resolvedTitle },
    });
  }
  const resolvedAuthor = familyName(metadata);
  if (
    claimed.firstAuthor &&
    resolvedAuthor &&
    !sameFamilyName(claimed.firstAuthor, resolvedAuthor)
  ) {
    drafts.push({
      kind: "details-differ",
      message: `The first author is ${claimed.firstAuthor} here; the registry has ${resolvedAuthor}.`,
      detail: `author:${resolvedAuthor}`,
    });
  }
  if (!preprintRecord && metadata.issuedYear !== null) {
    if (claimed.year !== null && claimed.year !== metadata.issuedYear) {
      drafts.push({
        kind: "details-differ",
        message: `The year is ${claimed.year} here; the registry has ${metadata.issuedYear}${Math.abs(claimed.year - metadata.issuedYear) === 1 ? " (online and print years often differ by one)" : ""}.`,
        detail: `year:${metadata.issuedYear}`,
        fix: { field: "year", value: String(metadata.issuedYear) },
      });
    } else if (claimed.year === null && claimed.raw) {
      const years = [...claimed.raw.matchAll(/\b(1[5-9]\d\d|20\d\d)\b/gu)].map((match) =>
        Number(match[1]),
      );
      if (years.length > 0 && !years.includes(metadata.issuedYear)) {
        drafts.push({
          kind: "details-differ",
          message: `The year is ${years[0]} here; the registry has ${metadata.issuedYear}.`,
          detail: `year:${metadata.issuedYear}`,
        });
      }
    }
  }
  if (
    !preprintRecord &&
    claimed.container &&
    metadata.containerTitle &&
    !venuesAgree(claimed.container, metadata.containerTitle)
  ) {
    drafts.push({
      kind: "details-differ",
      message: `The venue is “${claimed.container}” here; the registry has “${metadata.containerTitle}”.`,
      detail: `container:${metadata.containerTitle}`,
      fix: { field: "container", value: metadata.containerTitle },
    });
  }
  if (claimed.volume && metadata.volume && claimed.volume.trim() !== metadata.volume.trim()) {
    drafts.push({
      kind: "details-differ",
      message: `The volume is ${claimed.volume} here; the registry has ${metadata.volume}.`,
      detail: `volume:${metadata.volume}`,
      fix: { field: "volume", value: metadata.volume },
    });
  }
  if (claimed.pages && metadata.pages && firstPage(claimed.pages) !== firstPage(metadata.pages)) {
    drafts.push({
      kind: "details-differ",
      message: `The pages are ${claimed.pages} here; the registry has ${metadata.pages}.`,
      detail: `pages:${metadata.pages}`,
      fix: { field: "pages", value: metadata.pages },
    });
  }
  return drafts;
}

/** The registry's value for a field the reference lacks, when it has one. */
export function registryValue(
  metadata: ResolvedSourceMetadata,
  field: ComparableField | "author",
): string | null {
  switch (field) {
    case "title":
      return metadata.title ? withoutRetractionPrefix(metadata.title) : null;
    case "year":
      return metadata.issuedYear === null ? null : String(metadata.issuedYear);
    case "container":
      return metadata.containerTitle;
    case "volume":
      return metadata.volume;
    case "pages":
      return metadata.pages;
    case "publisher":
      return metadata.publisher;
    case "author":
      return null;
  }
}
