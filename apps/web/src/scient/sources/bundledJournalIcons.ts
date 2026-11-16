import acmUrl from "../../assets/journals/acm.png";
import ieeeUrl from "../../assets/journals/ieee.png";
import natureUrl from "../../assets/journals/nature.png";
import nejmGroupUrl from "../../assets/journals/nejm-group.png";
import pubmedUrl from "../../assets/journals/pubmed.png";

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

const naturePublisher: JournalIcon = {
  url: natureUrl,
  journalTitle: "Nature (publisher)",
  source: "journal",
};
const nejmPublisher: JournalIcon = {
  url: nejmGroupUrl,
  journalTitle: "NEJM Group (publisher)",
  source: "journal",
};
const ieeePublisher: JournalIcon = {
  url: ieeeUrl,
  journalTitle: "IEEE (publisher)",
  source: "journal",
};
const acmPublisher: JournalIcon = {
  url: acmUrl,
  journalTitle: "ACM (publisher)",
  source: "journal",
};
const pubmedPlatform: JournalIcon = {
  url: pubmedUrl,
  journalTitle: "PubMed (platform)",
  source: "site",
};

// Shared marks identify publishers, not distinct artwork for each of their journals.
const journals: ReadonlyArray<Journal> = [
  {
    title: "Nature",
    aliases: ["Nature (London)"],
    issns: ["0028-0836", "1476-4687"],
    icon: { url: natureUrl, journalTitle: "Nature", source: "journal" },
  },
  {
    title: "Nature Medicine",
    aliases: ["Nat Med"],
    issns: ["1078-8956", "1546-170X"],
    icon: naturePublisher,
  },
  {
    title: "npj Digital Medicine",
    aliases: ["npj Digit Med"],
    issns: ["2398-6352"],
    icon: naturePublisher,
  },
  {
    title: "NEJM AI",
    aliases: [],
    issns: ["2836-9386"],
    icon: nejmPublisher,
  },
  {
    title: "Nature Communications",
    aliases: ["Nat Commun"],
    issns: ["2041-1723"],
    icon: naturePublisher,
  },
  {
    title: "Scientific Reports",
    aliases: ["Sci Rep"],
    issns: ["2045-2322"],
    icon: naturePublisher,
  },
  {
    title: "Nature Methods",
    aliases: ["Nat Methods"],
    issns: ["1548-7091", "1548-7105"],
    icon: naturePublisher,
  },
  {
    title: "Nature Machine Intelligence",
    aliases: ["Nat Mach Intell"],
    issns: ["2522-5839"],
    icon: naturePublisher,
  },
  {
    title: "The New England Journal of Medicine",
    aliases: ["New England Journal of Medicine", "N Engl J Med", "NEJM"],
    issns: ["0028-4793", "1533-4406"],
    icon: nejmPublisher,
  },
  {
    title: "IEEE Access",
    aliases: [],
    issns: ["2169-3536"],
    icon: ieeePublisher,
  },
  {
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

const natureSite: JournalIcon = { ...naturePublisher, source: "site" };
const nejmSite: JournalIcon = { ...nejmPublisher, source: "site" };
const ieeeSite: JournalIcon = { ...ieeePublisher, source: "site" };
const acmSite: JournalIcon = { ...acmPublisher, source: "site" };

const publishersByHost: Readonly<Record<string, JournalIcon>> = {
  "nature.com": natureSite,
  "www.nature.com": natureSite,
  "nejm.org": nejmSite,
  "www.nejm.org": nejmSite,
  "ai.nejm.org": nejmSite,
  "evidence.nejm.org": nejmSite,
  "ieee.org": ieeeSite,
  "www.ieee.org": ieeeSite,
  "ieeexplore.ieee.org": ieeeSite,
  "acm.org": acmSite,
  "www.acm.org": acmSite,
  "dl.acm.org": acmSite,
  "pubmed.ncbi.nlm.nih.gov": pubmedPlatform,
};

export function bundledJournalIcon(record: JournalRecord): JournalIcon | null {
  if (record.type !== "article") return null;

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
