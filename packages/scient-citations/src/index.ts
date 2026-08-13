import type { ScientSourceCreator, ScientSourceRecord } from "@scientfactory/scient-sources";

import { renderCslBibliographyEntry } from "./cslEngine.ts";

export { SCIENT_REFERENCE_STYLES } from "./styles.ts";
export type { ScientReferenceStyleId } from "./styles.ts";

import type { ScientReferenceStyleId } from "./styles.ts";

type CslName = { readonly literal: string } | { readonly given?: string; readonly family?: string };

interface CslDate {
  readonly literal?: string;
  readonly "date-parts"?: ReadonlyArray<ReadonlyArray<number>>;
}

interface CslItem {
  readonly id: string;
  readonly type: string;
  readonly title?: string;
  readonly author?: ReadonlyArray<CslName>;
  readonly editor?: ReadonlyArray<CslName>;
  readonly translator?: ReadonlyArray<CslName>;
  readonly issued?: CslDate;
  readonly abstract?: string;
  readonly "container-title"?: string;
  readonly publisher?: string;
  readonly volume?: string;
  readonly issue?: string;
  readonly page?: string;
  readonly language?: string;
  readonly URL?: string;
  readonly DOI?: string;
  readonly ISBN?: string;
  readonly ISSN?: string;
  readonly genre?: string;
}

const CSL_TYPE_BY_SCIENT_TYPE: Readonly<Record<ScientSourceRecord["type"], string>> = {
  article: "article-journal",
  preprint: "article",
  book: "book",
  "book-chapter": "chapter",
  "conference-paper": "paper-conference",
  thesis: "thesis",
  report: "report",
  dataset: "dataset",
  web: "webpage",
  other: "document",
};

function nonEmpty(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function creatorName(creator: ScientSourceCreator): CslName | null {
  const literal = nonEmpty(creator.literalName);
  if (literal) return { literal };

  const given = nonEmpty(creator.givenName);
  const family = nonEmpty(creator.familyName);
  if (!given && !family) return null;
  return { ...(given ? { given } : {}), ...(family ? { family } : {}) };
}

function creatorsForRoles(
  creators: ReadonlyArray<ScientSourceCreator>,
  roles: ReadonlySet<string>,
): ReadonlyArray<CslName> | undefined {
  const names = creators.flatMap((creator) => {
    if (!roles.has(creator.creatorType.trim().toLowerCase())) return [];
    const name = creatorName(creator);
    return name ? [name] : [];
  });
  return names.length > 0 ? names : undefined;
}

function sourceIdentifier(record: ScientSourceRecord, scheme: string): string | undefined {
  const identifier = record.identifiers.find(
    (candidate) => candidate.scheme.trim().toLowerCase() === scheme,
  );
  return nonEmpty(identifier?.value ?? null);
}

function issuedDate(record: ScientSourceRecord): CslDate | undefined {
  const raw = nonEmpty(record.issuedRaw);
  const match = raw?.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/u);
  const parsedYear = match?.[1] ? Number(match[1]) : null;
  const year = record.issuedYear ?? parsedYear;

  if (year !== null) {
    const parts = [year];
    const month = match?.[2] ? Number(match[2]) : null;
    const day = match?.[3] ? Number(match[3]) : null;
    if (month !== null && month >= 1 && month <= 12) {
      parts.push(month);
      if (day !== null && day >= 1 && day <= 31) parts.push(day);
    }
    return { "date-parts": [parts] };
  }

  return raw ? { literal: raw } : undefined;
}

const AUTHOR_ROLES = new Set(["author", "bookauthor"]);
const EDITOR_ROLES = new Set(["editor", "serieseditor"]);
const TRANSLATOR_ROLES = new Set(["translator"]);

export function scientSourceToCslJson(record: ScientSourceRecord): CslItem {
  const author = creatorsForRoles(record.creators, AUTHOR_ROLES);
  const editor = creatorsForRoles(record.creators, EDITOR_ROLES);
  const translator = creatorsForRoles(record.creators, TRANSLATOR_ROLES);
  const title = nonEmpty(record.title);
  const abstract = nonEmpty(record.abstract);
  const containerTitle = nonEmpty(record.containerTitle);
  const publisher = nonEmpty(record.publisher);
  const volume = nonEmpty(record.volume);
  const issue = nonEmpty(record.issue);
  const page = nonEmpty(record.pages);
  const language = nonEmpty(record.language);
  const url = nonEmpty(record.url);
  const doi = sourceIdentifier(record, "doi");
  const isbn = sourceIdentifier(record, "isbn");
  const issn = sourceIdentifier(record, "issn");
  const issued = issuedDate(record);

  return {
    id: record.sourceId,
    type: CSL_TYPE_BY_SCIENT_TYPE[record.type],
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(editor ? { editor } : {}),
    ...(translator ? { translator } : {}),
    ...(issued ? { issued } : {}),
    ...(abstract ? { abstract } : {}),
    ...(containerTitle ? { "container-title": containerTitle } : {}),
    ...(publisher ? { publisher } : {}),
    ...(volume ? { volume } : {}),
    ...(issue ? { issue } : {}),
    ...(page ? { page } : {}),
    ...(language ? { language } : {}),
    ...(url ? { URL: url } : {}),
    ...(doi ? { DOI: doi } : {}),
    ...(isbn ? { ISBN: isbn } : {}),
    ...(issn ? { ISSN: issn } : {}),
    ...(record.type === "preprint"
      ? { genre: "Preprint" }
      : record.type === "other" && record.customType?.trim()
        ? { genre: record.customType.trim() }
        : {}),
  };
}

export function formatSourceReference(
  record: ScientSourceRecord,
  style: ScientReferenceStyleId,
): string {
  const formatted = renderCslBibliographyEntry(scientSourceToCslJson(record), style)
    .replace(/\r\n?/gu, "\n")
    .trim();

  if (!formatted) throw new Error("The citation processor returned an empty reference.");
  return formatted;
}
