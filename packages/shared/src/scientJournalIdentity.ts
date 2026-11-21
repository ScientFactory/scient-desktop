interface JournalRecord {
  readonly type: string;
  readonly containerTitle: string | null;
  readonly publisher?: string | null;
  readonly identifiers: ReadonlyArray<{ readonly scheme: string; readonly value: string }>;
}

export function journalIconIdentity(record: JournalRecord): string | null {
  if (!["article", "conference-paper", "preprint"].includes(record.type)) return null;
  const title = record.containerTitle?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  if (!title) return null;
  const issns = record.identifiers
    .filter(({ scheme }) => /^e?issn$/iu.test(scheme.trim()))
    .map(({ value }) => value.replace(/[-\s]/gu, "").toUpperCase())
    .filter((value) => /^\d{7}[\dX]$/u.test(value))
    .sort();
  const publisher =
    record.publisher?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
  // Publisher fallbacks and preprint platforms are evidence-dependent: an incorrect
  // record must not brand another record merely because their ISSN is the same.
  return JSON.stringify([
    record.type === "preprint" ? "preprint" : "published",
    issns[0] ?? null,
    title,
    publisher,
  ]);
}

/** The record's DOI as Scient compares DOIs: lower case, without a resolver or `doi:` label. */
export function journalRecordDoi(record: Pick<JournalRecord, "identifiers">): string | null {
  const doi = record.identifiers.find(({ scheme }) => scheme.trim().toLowerCase() === "doi");
  const value = doi?.value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//u, "")
    .replace(/^doi:\s*/u, "");
  return value || null;
}

/**
 * What a DOI says about its journal's cover: the registrant, a Springer Nature journal number
 * (`s12913-…`), or an ISSN embedded in an older Wiley or Elsevier DOI (`j.1553-2712.…`,
 * `S0140-6736(…)`). Papers of one journal share these.
 */
export function journalCoverDoiParts(doi: string | null): {
  readonly prefix: string;
  readonly springerJournal: string | null;
  readonly embeddedIssn: string | null;
} | null {
  const match = doi?.match(/^(10\.\d{4,9})\/(?:s(\d{5})-|(?:j\.|s)(\d{4}-\d{3}[\dx])[.(])?/u);
  return match?.[1]
    ? { prefix: match[1], springerJournal: match[2] ?? null, embeddedIssn: match[3] ?? null }
    : null;
}

/** Only journal articles and conference papers have a journal cover to fetch. */
export function journalCoverEligible(record: JournalRecord): boolean {
  return (
    ["article", "conference-paper"].includes(record.type) && journalIconIdentity(record) !== null
  );
}
