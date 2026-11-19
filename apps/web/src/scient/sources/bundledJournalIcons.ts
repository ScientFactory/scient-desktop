import acmUrl from "../../assets/journals/acm.png";
import ieeeUrl from "../../assets/journals/ieee.png";
import nejmEvidenceUrl from "../../assets/journals/nejm-evidence.png";
import pubmedUrl from "../../assets/journals/pubmed.png";
import { msg } from "gt-react";

type JournalIcon = {
  readonly url: string;
  readonly journalTitle: string;
  readonly source: "journal" | "site";
};

type JournalRecord = {
  readonly type: string;
  readonly containerTitle: string | null;
  readonly identifiers: ReadonlyArray<{ readonly scheme: string; readonly value: string }>;
  readonly url: string | null;
};

type Journal = {
  readonly title: string;
  readonly aliases: ReadonlyArray<string>;
  readonly issns: ReadonlyArray<string>;
  readonly icon: JournalIcon;
};

const ieeePublisher: JournalIcon = {
  url: ieeeUrl,
  journalTitle: msg("IEEE (publisher)"),
  source: "site",
};
const acmPublisher: JournalIcon = {
  url: acmUrl,
  journalTitle: msg("ACM (publisher)"),
  source: "site",
};
const pubmedPlatform: JournalIcon = {
  url: pubmedUrl,
  journalTitle: msg("PubMed (platform)"),
  source: "site",
};

const journals: ReadonlyArray<Journal> = [
  {
    // oxlint-disable-next-line t3code/no-untranslated-copy -- a journal's name
    title: "NEJM Evidence",
    aliases: ["NEJM Evid"],
    issns: ["2766-5526"],
    // oxlint-disable-next-line t3code/no-untranslated-copy -- a journal's name
    icon: { url: nejmEvidenceUrl, journalTitle: "NEJM Evidence", source: "journal" },
  },
  {
    // oxlint-disable-next-line t3code/no-untranslated-copy -- a journal's name
    title: "IEEE Access",
    aliases: [],
    issns: ["2169-3536"],
    icon: ieeePublisher,
  },
  {
    // oxlint-disable-next-line t3code/no-untranslated-copy -- a journal's name
    title: "ACM Computing Surveys",
    aliases: ["ACM Comput Surv"],
    issns: ["0360-0300", "1557-7341"],
    icon: acmPublisher,
  },
];

function normalizedTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

function normalizedIssn(issn: string): string {
  return issn.replace(/[-\s]/g, "").toUpperCase();
}

const journalsByTitle = new Map<string, Journal>();
const journalsByIssn = new Map<string, Journal>();
for (const journal of journals) {
  journalsByTitle.set(normalizedTitle(journal.title), journal);
  for (const alias of journal.aliases) journalsByTitle.set(normalizedTitle(alias), journal);
  for (const issn of journal.issns) journalsByIssn.set(normalizedIssn(issn), journal);
}

const publishersByHost: Readonly<Record<string, JournalIcon>> = {
  "ieee.org": ieeePublisher,
  "www.ieee.org": ieeePublisher,
  "ieeexplore.ieee.org": ieeePublisher,
  "acm.org": acmPublisher,
  "www.acm.org": acmPublisher,
  "dl.acm.org": acmPublisher,
  "pubmed.ncbi.nlm.nih.gov": pubmedPlatform,
};

export function bundledJournalIcon(record: JournalRecord): JournalIcon | null {
  if (!["article", "conference-paper", "preprint"].includes(record.type)) return null;

  const titleMatch = record.containerTitle
    ? journalsByTitle.get(normalizedTitle(record.containerTitle))
    : undefined;
  let issnMatch: Journal | undefined;
  let hasIssn = false;
  for (const identifier of record.identifiers) {
    if (!/^(?:e)?issn$/i.test(identifier.scheme.trim())) continue;
    const issn = normalizedIssn(identifier.value);
    if (!/^\d{7}[\dX]$/.test(issn)) continue;
    hasIssn = true;
    const match = journalsByIssn.get(issn);
    if (!match) continue;
    if (issnMatch && issnMatch !== match) return null;
    issnMatch = match;
  }
  if (issnMatch && titleMatch && issnMatch !== titleMatch) return null;
  const journal = issnMatch ?? (hasIssn ? undefined : titleMatch);
  if (journal) return journal.icon;

  if (!record.url) return null;
  try {
    const url = new URL(record.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return Object.hasOwn(publishersByHost, url.hostname)
      ? (publishersByHost[url.hostname] ?? null)
      : null;
  } catch {
    return null;
  }
}
