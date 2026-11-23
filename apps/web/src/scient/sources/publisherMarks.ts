import { journalCoverDoiParts, journalRecordDoi } from "@t3tools/shared/scientJournalIdentity";

/** Served as files, not inlined: there are many icons and any one screen shows a few of them. */
const ICON_FILES = import.meta.glob<string>("../../assets/publishers/*.png", {
  eager: true,
  import: "default",
  query: "?url&no-inline",
});

export type PublisherMark = {
  /** The publisher or platform whose website icon this is, shown in the tooltip. */
  readonly name: string;
  readonly url: string;
};

type PublisherRecord = {
  readonly type: string;
  readonly containerTitle: string | null;
  readonly publisher?: string | null;
  readonly identifiers: ReadonlyArray<{ readonly scheme: string; readonly value: string }>;
  readonly url: string | null;
};

const PUBLISHERS = {
  aap: "American Academy of Pediatrics",
  ada: "American Diabetes Association",
  ajr: "American Journal of Roentgenology",
  annfammed: "Annals of Family Medicine",
  arvo: "ARVO Journals",
  baishideng: "Baishideng Publishing Group",
  bioscientifica: "Bioscientifica",
  cureus: "Cureus",
  liebert: "Mary Ann Liebert",
  verduci: "Verduci Editore",
  appi: "American Psychiatric Association",
  ash: "American Society of Hematology",
  cochrane: "Cochrane Library",
  ers: "European Respiratory Society",
  jmir: "JMIR Publications",
  rsna: "Radiological Society of North America",
  snmmi: "Society of Nuclear Medicine and Molecular Imaging",
  acl: "ACL Anthology",
  acm: "ACM",
  acpjournals: "ACP Journals",
  acs: "ACS Publications",
  aha: "American Heart Association",
  aip: "AIP Publishing",
  ajtmh: "American Society of Tropical Medicine and Hygiene",
  ams: "American Mathematical Society",
  annualreviews: "Annual Reviews",
  aps: "American Physical Society",
  arxiv: "arXiv",
  asm: "American Society for Microbiology",
  biorxiv: "bioRxiv",
  bmc: "BMC",
  bmj: "BMJ",
  cell: "Cell Press",
  cmaj: "CMAJ",
  cup: "Cambridge University Press",
  degruyter: "De Gruyter Brill",
  dovepress: "Dove Medical Press",
  elife: "eLife",
  elsevier: "Elsevier",
  frontiers: "Frontiers",
  healthaffairs: "Health Affairs",
  ieee: "IEEE",
  iop: "IOP Publishing",
  jama: "JAMA Network",
  jci: "Journal of Clinical Investigation",
  jneurosci: "Society for Neuroscience",
  karger: "Karger",
  lancet: "The Lancet",
  lww: "Wolters Kluwer",
  mdpi: "MDPI",
  medrxiv: "medRxiv",
  mitpress: "MIT Press",
  nature: "Nature Portfolio",
  nejm: "NEJM Group",
  neurips: "NeurIPS",
  optica: "Optica Publishing Group",
  oup: "Oxford University Press",
  peerj: "PeerJ",
  physiology: "American Physiological Society",
  plos: "PLOS",
  pnas: "PNAS",
  projecteuclid: "Project Euclid",
  researchsquare: "Research Square",
  royalsociety: "The Royal Society",
  rsc: "Royal Society of Chemistry",
  rupress: "Rockefeller University Press",
  sage: "SAGE",
  science: "Science",
  siam: "SIAM",
  spie: "SPIE",
  springer: "Springer",
  ssrn: "SSRN",
  tandf: "Taylor & Francis",
  thieme: "Thieme",
  westjem: "Western Journal of Emergency Medicine",
  wiley: "Wiley",
} as const;

type PublisherKey = keyof typeof PUBLISHERS;

/** A DOI's registrant prefix names its publisher far more reliably than free-text fields. */
const DOI_PREFIXES: Readonly<Record<string, PublisherKey>> = {
  "10.1016": "elsevier",
  "10.1053": "elsevier",
  "10.1054": "elsevier",
  "10.1067": "elsevier",
  "10.1078": "elsevier",
  "10.1002": "wiley",
  "10.1111": "wiley",
  "10.1113": "wiley",
  "10.1155": "wiley",
  "10.1007": "springer",
  "10.1038": "nature",
  "10.1186": "bmc",
  "10.1080": "tandf",
  "10.1177": "sage",
  "10.1093": "oup",
  "10.1017": "cup",
  "10.1088": "iop",
  "10.1103": "aps",
  "10.1063": "aip",
  "10.1109": "ieee",
  "10.1145": "acm",
  "10.1021": "acs",
  "10.1039": "rsc",
  "10.3390": "mdpi",
  "10.1371": "plos",
  "10.3389": "frontiers",
  "10.1056": "nejm",
  "10.1001": "jama",
  "10.1136": "bmj",
  "10.1126": "science",
  "10.1073": "pnas",
  "10.1097": "lww",
  "10.1161": "aha",
  "10.48550": "arxiv",
  "10.21203": "researchsquare",
  "10.2139": "ssrn",
  "10.7554": "elife",
  "10.1146": "annualreviews",
  "10.1098": "royalsociety",
  "10.1137": "siam",
  "10.1090": "ams",
  "10.1214": "projecteuclid",
  "10.18653": "acl",
  "10.1162": "mitpress",
  "10.1364": "optica",
  "10.1128": "asm",
  "10.1542": "aap",
  "10.1377": "healthaffairs",
  "10.1503": "cmaj",
  "10.9778": "cmaj",
  "10.1172": "jci",
  "10.1083": "rupress",
  "10.1084": "rupress",
  "10.1515": "degruyter",
  "10.1159": "karger",
  "10.1055": "thieme",
  "10.7717": "peerj",
  "10.2147": "dovepress",
  "10.1117": "spie",
  "10.1523": "jneurosci",
  "10.1152": "physiology",
  "10.7326": "acpjournals",
  "10.4269": "ajtmh",
  "10.5811": "westjem",
  "10.1148": "rsna",
  "10.2337": "ada",
  "10.1182": "ash",
  "10.1176": "appi",
  "10.1183": "ers",
  "10.2214": "ajr",
  "10.2967": "snmmi",
  "10.1370": "annfammed",
  "10.2196": "jmir",
  "10.1167": "arvo",
  "10.4239": "baishideng",
  "10.1530": "bioscientifica",
  "10.7759": "cureus",
  "10.1089": "liebert",
  "10.26355": "verduci",
  "10.1185": "tandf",
  "10.4103": "lww",
  "10.2215": "lww",
  "10.1096": "wiley",
  "10.2991": "springer",
  "10.1208": "springer",
  "10.3184": "sage",
  "10.7556": "degruyter",
  "10.3945": "elsevier",
  "10.1210": "oup",
  "10.34133": "science",
};

/** Publisher names as registries spell them; matched as whole words. */
const PUBLISHER_NAMES: ReadonlyArray<readonly [RegExp, PublisherKey]> = [
  [/\bcell press\b/u, "cell"],
  [/\belsevier\b/u, "elsevier"],
  [/\bwiley\b/u, "wiley"],
  [/\bbiomed central\b|\bbmc\b/u, "bmc"],
  [/\bspringer\b/u, "springer"],
  [/\bnature\b/u, "nature"],
  [/\btaylor (?:&|and) francis\b|\broutledge\b/u, "tandf"],
  [/\bsage\b/u, "sage"],
  [/\boxford university press\b/u, "oup"],
  [/\bcambridge university press\b/u, "cup"],
  [/\binstitute of electrical and electronics engineers\b|\bieee\b/u, "ieee"],
  [/\bassociation for computing machinery\b|\bacm\b/u, "acm"],
  [/\bamerican chemical society\b/u, "acs"],
  [/\bmultidisciplinary digital publishing institute\b|\bmdpi\b/u, "mdpi"],
  [/\bpublic library of science\b|\bplos\b/u, "plos"],
  [/\bfrontiers\b/u, "frontiers"],
  [/\bmassachusetts medical society\b/u, "nejm"],
  [/\bamerican medical association\b/u, "jama"],
  [/\bbmj\b/u, "bmj"],
  [/\bamerican association for the advancement of science\b/u, "science"],
  [/\bproceedings of the national academy of sciences\b/u, "pnas"],
  [/\blippincott\b|\bwolters kluwer\b/u, "lww"],
  [/\bamerican physical society\b/u, "aps"],
  [/\bioP publishing\b|\binstitute of physics\b/iu, "iop"],
  [/\baip publishing\b|\bamerican institute of physics\b/u, "aip"],
  [/\broyal society of chemistry\b/u, "rsc"],
  [/\bradiological society of north america\b|\brsna\b/u, "rsna"],
  [/\bmit press\b/u, "mitpress"],
  [/\bamerican diabetes association\b/u, "ada"],
  [/\bamerican society of hematology\b/u, "ash"],
  [/\bamerican psychiatric\b/u, "appi"],
  [/\beuropean respiratory society\b/u, "ers"],
  [/\bjmir\b/u, "jmir"],
  [/\bcureus\b/u, "cureus"],
  [/\bmary ann liebert\b/u, "liebert"],
  [/\bbioscientifica\b/u, "bioscientifica"],
  [/\bbaishideng\b/u, "baishideng"],
];

/**
 * Journals with their own website icon, which their publisher's records do not reveal. A family
 * tied to a publisher applies only when the DOI or publisher field names that publisher too.
 */
const JOURNAL_FAMILIES: ReadonlyArray<
  readonly [title: RegExp, key: PublisherKey, publisher?: PublisherKey]
> = [
  [/^(?:the )?lancet\b/u, "lancet", "elsevier"],
  [
    /^(?:cell|cell reports|cell metabolism|cell stem cell|cell host & microbe|cell systems|cell chemical biology|cell genomics|cell reports medicine|cell reports methods|cell reports physical science|neuron|immunity|molecular cell|developmental cell|current biology|structure|chem|joule|matter|one earth|patterns|iscience|med|the american journal of human genetics|biophysical journal|trends in [a-z ]+)$/u,
    "cell",
    "elsevier",
  ],
  [/^nature\b/u, "nature", "springer"],
  [/^(?:western journal of emergency medicine|westjem)\b/u, "westjem"],
  [/^cochrane database of systematic reviews\b/u, "cochrane", "wiley"],
  [/^medrxiv\b/u, "medrxiv"],
  [/^biorxiv\b/u, "biorxiv"],
  [/^arxiv\b/u, "arxiv"],
  [/^research square\b/u, "researchsquare"],
  [/^ssrn\b/u, "ssrn"],
  [/^(?:advances in )?neural information processing systems\b|^neurips\b/u, "neurips"],
];

/** Article and preprint URLs on these sites belong to that publisher or platform. */
const HOSTS: Readonly<Record<string, PublisherKey>> = {
  "arxiv.org": "arxiv",
  "biorxiv.org": "biorxiv",
  "medrxiv.org": "medrxiv",
  "researchsquare.com": "researchsquare",
  "ssrn.com": "ssrn",
  "ieeexplore.ieee.org": "ieee",
  "dl.acm.org": "acm",
  "sciencedirect.com": "elsevier",
  "thelancet.com": "lancet",
  "cell.com": "cell",
  "nature.com": "nature",
  "link.springer.com": "springer",
  "onlinelibrary.wiley.com": "wiley",
  "nejm.org": "nejm",
  "jamanetwork.com": "jama",
  "bmj.com": "bmj",
  "science.org": "science",
  "pnas.org": "pnas",
  "journals.plos.org": "plos",
  "academic.oup.com": "oup",
  "tandfonline.com": "tandf",
  "journals.sagepub.com": "sage",
  "mdpi.com": "mdpi",
  "frontiersin.org": "frontiers",
  "proceedings.neurips.cc": "neurips",
  "papers.nips.cc": "neurips",
  "aclanthology.org": "acl",
  "cureus.com": "cureus",
};

function mark(key: PublisherKey): PublisherMark | null {
  const url = ICON_FILES[`../../assets/publishers/${key}.png`];
  return url ? { name: PUBLISHERS[key], url } : null;
}

const normalized = (value: string | null | undefined) =>
  (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

function doiPrefix(record: PublisherRecord): string | null {
  return journalCoverDoiParts(journalRecordDoi(record))?.prefix ?? null;
}

/**
 * bioRxiv shares 10.1101 with Cold Spring Harbor's journals (`gad.`, `gr.`, `cshperspect.`);
 * its own DOIs are dated (`10.1101/2024.01.02.123456`) or, before 2019, plain numbers.
 */
const isBiorxivDoi = (doi: string | null) =>
  doi !== null && /^10\.1101\/(?:\d{4}\.\d{2}\.\d{2}\.)?\d+(?:v\d+)?$/u.test(doi);

function hostKey(url: string | null): PublisherKey | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
    for (const [site, key] of Object.entries(HOSTS)) {
      if (host === site || host.endsWith(`.${site}`)) return key;
    }
  } catch {
    // Not a URL; other evidence decides.
  }
  return null;
}

/**
 * The website icon of the source's publisher or platform: the journal's own family when it
 * has one (The Lancet, Cell Press), else the publisher named by the DOI, the publisher field,
 * or the article's website. Null when nothing identifies one.
 */
export function publisherMark(record: PublisherRecord): PublisherMark | null {
  if (!["article", "conference-paper", "preprint", "book", "book-chapter"].includes(record.type))
    return null;
  const prefix = doiPrefix(record);
  const publisherText = normalized(record.publisher);
  const byDoi = prefix ? DOI_PREFIXES[prefix] : undefined;
  const byName = PUBLISHER_NAMES.find(([pattern]) => pattern.test(publisherText))?.[1];
  const byHost = hostKey(record.url);
  const publisher = byDoi ?? byName ?? byHost;
  const title = normalized(record.containerTitle);
  for (const [pattern, key, owner] of JOURNAL_FAMILIES) {
    if (!pattern.test(title)) continue;
    // Springer Nature registers Nature journals under both names.
    const owned =
      !owner ||
      publisher === owner ||
      publisher === key ||
      (owner === "springer" && publisher === "nature");
    if (owned) return mark(key);
  }
  // bioRxiv and medRxiv share one DOI prefix; a medRxiv title was matched above.
  if (isBiorxivDoi(journalRecordDoi(record))) return mark("biorxiv");
  return publisher ? mark(publisher) : null;
}
