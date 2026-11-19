export function journalIconIdentity(record: {
  readonly type: string;
  readonly containerTitle: string | null;
  readonly publisher?: string | null;
  readonly identifiers: ReadonlyArray<{ readonly scheme: string; readonly value: string }>;
}): string | null {
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
