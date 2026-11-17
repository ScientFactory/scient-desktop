import acmUrl from "../../assets/journals/acm.png";
import ieeeUrl from "../../assets/journals/ieee.png";
import nejmEvidenceUrl from "../../assets/journals/nejm-evidence.png";

/**
 * Marks that ship with Scient, each for its exact match only (provenance in
 * assets/journals/NOTICE). A journal mark needs its journal; a publisher mark is shown only for a
 * record that names no journal or venue and whose publisher is exactly that publisher.
 */
export type BundledMark = {
  readonly url: string;
  /** What hover and screen readers say. */
  readonly label: string;
  readonly kind: "journal" | "publisher";
};

type MarkRecord = {
  readonly type: string;
  readonly containerTitle: string | null;
  readonly containerTitleShort?: string;
  readonly publisher?: string | null;
  readonly identifiers: ReadonlyArray<{ readonly scheme: string; readonly value: string }>;
};

/** Record types whose container is a journal, proceedings or preprint server. */
export const VENUE_TYPES: ReadonlySet<string> = new Set([
  "article",
  "conference-paper",
  "preprint",
]);

const JOURNALS: ReadonlyArray<{
  readonly titles: ReadonlyArray<string>;
  readonly issns: ReadonlyArray<string>;
  readonly mark: BundledMark;
}> = [
  {
    titles: ["NEJM Evidence", "NEJM Evid"],
    issns: ["2766-5526"],
    mark: { url: nejmEvidenceUrl, label: "Journal: NEJM Evidence", kind: "journal" },
  },
];

const PUBLISHERS: ReadonlyArray<{
  readonly names: ReadonlyArray<string>;
  readonly mark: BundledMark;
}> = [
  {
    names: ["IEEE", "Institute of Electrical and Electronics Engineers"],
    mark: { url: ieeeUrl, label: "Publisher: IEEE", kind: "publisher" },
  },
  {
    names: ["ACM", "Association for Computing Machinery"],
    mark: { url: acmUrl, label: "Publisher: ACM", kind: "publisher" },
  },
];

const normalizedName = (name: string) =>
  name.normalize("NFKC").toLowerCase().replace(/\./gu, "").replace(/\s+/gu, " ").trim();
const normalizedIssn = (issn: string) => issn.replace(/[-\s]/gu, "").toUpperCase();

const journalsByTitle = new Map<string, BundledMark>();
const journalsByIssn = new Map<string, BundledMark>();
for (const journal of JOURNALS) {
  for (const title of journal.titles) journalsByTitle.set(normalizedName(title), journal.mark);
  for (const issn of journal.issns) journalsByIssn.set(normalizedIssn(issn), journal.mark);
}
const publishersByName = new Map<string, BundledMark>();
for (const publisher of PUBLISHERS) {
  for (const name of publisher.names) publishersByName.set(normalizedName(name), publisher.mark);
}

/** The bundled mark for exactly this record, or null when the generated mark or type icon shows. */
export function bundledJournalMark(record: MarkRecord): BundledMark | null {
  const container = record.containerTitle?.trim() || record.containerTitleShort?.trim();
  if (container) {
    if (!VENUE_TYPES.has(record.type)) return null;
    const issns = record.identifiers
      .filter(({ scheme }) => /^e?issn$/iu.test(scheme.trim()))
      .map(({ value }) => normalizedIssn(value))
      .filter((issn) => /^\d{7}[\dX]$/u.test(issn));
    // An ISSN decides: a title match with another journal's ISSN is not that journal.
    if (issns.length > 0) {
      const matches = new Set(issns.flatMap((issn) => journalsByIssn.get(issn) ?? []));
      const [only] = matches;
      return matches.size === 1 ? only! : null;
    }
    return journalsByTitle.get(normalizedName(container)) ?? null;
  }
  const publisher = record.publisher?.trim();
  return publisher ? (publishersByName.get(normalizedName(publisher)) ?? null) : null;
}
