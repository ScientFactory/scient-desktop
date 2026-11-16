export function journalIconIdentity(record: {
  readonly type: string;
  readonly containerTitle: string | null;
  readonly publisher?: string | null;
  readonly identifiers: ReadonlyArray<{ readonly scheme: string; readonly value: string }>;
}): string | null {
  if (record.type !== "article") return null;
  const title = record.containerTitle?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  if (!title) return null;
  const issns = record.identifiers
    .filter(({ scheme }) => /^e?issn$/iu.test(scheme.trim()))
    .map(({ value }) => value.replace(/[-\s]/gu, "").toUpperCase())
    .filter((value) => /^\d{7}[\dX]$/u.test(value))
    .sort();
  if (issns[0]) return `issn:${issns[0]}`;
  const publisher =
    record.publisher?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
  return JSON.stringify([title, publisher]);
}
