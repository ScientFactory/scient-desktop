import type { ScientSourceType } from "./model.ts";
import type { ScientSourceMoreName } from "./sourceMore.ts";

/**
 * Zotero's field, role and type map, as importing and citing its references needs it: Scient's
 * own statement of the facts Zotero publishes for apps at `api.zotero.org/schema`, read from
 * this version. `pnpm check:zotero-schema` prints what differs from Zotero's current one.
 */
export const ZOTERO_SCHEMA_VERSION = 45;

/** A type's own name for a general field (`caseName` is a case's title). */
export const ZOTERO_BASE_FIELD: Readonly<Record<string, string>> = {
  caseName: "title",
  nameOfAct: "title",
  subject: "title",
  dateDecided: "date",
  dateEnacted: "date",
  issueDate: "date",
  priorityDate: "originalDate",
  codeVolume: "volume",
  reporterVolume: "volume",
  codePages: "pages",
  firstPage: "pages",
  repositoryLocation: "place",
  legalStatus: "status",
  ...Object.fromEntries(
    [
      "blogTitle",
      "bookTitle",
      "dictionaryTitle",
      "encyclopediaTitle",
      "forumTitle",
      "proceedingsTitle",
      "programTitle",
      "sessionTitle",
      "websiteTitle",
    ].map((name) => [name, "publicationTitle"]),
  ),
  ...Object.fromEntries(
    [
      "company",
      "distributor",
      "institution",
      "label",
      "network",
      "repository",
      "studio",
      "university",
    ].map((name) => [name, "publisher"]),
  ),
  ...Object.fromEntries(
    [
      "archiveID",
      "billNumber",
      "docketNumber",
      "documentNumber",
      "episodeNumber",
      "identifier",
      "patentNumber",
      "publicLawNumber",
      "reportNumber",
    ].map((name) => [name, "number"]),
  ),
  ...Object.fromEntries(
    [
      "genre",
      "letterType",
      "manuscriptType",
      "mapType",
      "postType",
      "presentationType",
      "reportType",
      "thesisType",
      "websiteType",
    ].map((name) => [name, "type"]),
  ),
  ...Object.fromEntries(
    [
      "artworkMedium",
      "audioFileType",
      "audioRecordingFormat",
      "format",
      "interviewMedium",
      "videoRecordingFormat",
    ].map((name) => [name, "medium"]),
  ),
  ...Object.fromEntries(
    ["court", "issuingAuthority", "legislativeBody", "organization"].map((name) => [
      name,
      "authority",
    ]),
  ),
};

/** The record's own fields a general Zotero field fills. */
export type ZoteroTypedTarget =
  | "title"
  | "issuedRaw"
  | "abstract"
  | "containerTitle"
  | "publisher"
  | "volume"
  | "issue"
  | "pages"
  | "language"
  | "url";

/** Where a general Zotero field goes: one of the record's own fields, or a `more` entry. */
export const ZOTERO_FIELD_TARGET: Readonly<
  Record<string, { readonly typed: ZoteroTypedTarget } | { readonly more: ScientSourceMoreName }>
> = {
  title: { typed: "title" },
  date: { typed: "issuedRaw" },
  abstractNote: { typed: "abstract" },
  publicationTitle: { typed: "containerTitle" },
  reporter: { typed: "containerTitle" },
  code: { typed: "containerTitle" },
  publisher: { typed: "publisher" },
  volume: { typed: "volume" },
  codeNumber: { typed: "volume" },
  issue: { typed: "issue" },
  priorityNumbers: { typed: "issue" },
  pages: { typed: "pages" },
  language: { typed: "language" },
  url: { typed: "url" },
  place: { more: "publisher-place" },
  edition: { more: "edition" },
  series: { more: "collection-title" },
  seriesTitle: { more: "collection-title" },
  seriesNumber: { more: "collection-number" },
  numPages: { more: "number-of-pages" },
  numberOfVolumes: { more: "number-of-volumes" },
  shortTitle: { more: "title-short" },
  journalAbbreviation: { more: "container-title-short" },
  meetingName: { more: "event-title" },
  conferenceName: { more: "event-title" },
  eventPlace: { more: "event-place" },
  type: { more: "genre" },
  programmingLanguage: { more: "genre" },
  medium: { more: "medium" },
  system: { more: "medium" },
  number: { more: "number" },
  versionNumber: { more: "version" },
  authority: { more: "authority" },
  section: { more: "section" },
  committee: { more: "section" },
  status: { more: "status" },
  archive: { more: "archive" },
  archiveLocation: { more: "archive_location" },
  callNumber: { more: "call-number" },
  applicationNumber: { more: "call-number" },
  libraryCatalog: { more: "source" },
  rights: { more: "license" },
  artworkSize: { more: "dimensions" },
  runningTime: { more: "dimensions" },
  scale: { more: "scale" },
  history: { more: "references" },
  references: { more: "references" },
  session: { more: "chapter-number" },
  partNumber: { more: "part-number" },
  partTitle: { more: "part-title" },
  originalPublisher: { more: "original-publisher" },
  originalPlace: { more: "original-publisher-place" },
  accessDate: { more: "accessed" },
  originalDate: { more: "original-date" },
  filingDate: { more: "submitted" },
};

/** The CSL variable each Zotero creator role is cited under. */
export const ZOTERO_ROLE_CSL: Readonly<Record<string, string>> = {
  author: "author",
  bookauthor: "container-author",
  chair: "chair",
  castmember: "performer",
  composer: "composer",
  contributor: "contributor",
  creator: "author",
  director: "director",
  editor: "editor",
  executiveproducer: "executive-producer",
  guest: "guest",
  host: "host",
  interviewer: "interviewer",
  narrator: "narrator",
  originalcreator: "original-author",
  organizer: "organizer",
  podcaster: "host",
  producer: "producer",
  recipient: "recipient",
  reviewedauthor: "reviewed-author",
  seriescreator: "series-creator",
  serieseditor: "collection-editor",
  scriptwriter: "script-writer",
  translator: "translator",
};

/** The roles as Zotero spells them, for the ones whose name has an inner capital. */
export const ZOTERO_ROLE_SPELLING: Readonly<Record<string, string>> = {
  bookauthor: "bookAuthor",
  castmember: "castMember",
  executiveproducer: "executiveProducer",
  originalcreator: "originalCreator",
  reviewedauthor: "reviewedAuthor",
  seriescreator: "seriesCreator",
  serieseditor: "seriesEditor",
};

/** The role Zotero cites as the author for a type whose makers are not called authors. */
export const ZOTERO_PRIMARY_ROLE: Readonly<Record<string, string>> = {
  artwork: "artist",
  audioRecording: "performer",
  bill: "sponsor",
  computerProgram: "programmer",
  film: "director",
  hearing: "contributor",
  interview: "interviewee",
  map: "cartographer",
  patent: "inventor",
  podcast: "podcaster",
  presentation: "presenter",
  radioBroadcast: "creator",
  tvBroadcast: "director",
  videoRecording: "creator",
};

/** The CSL type of each Zotero item type. */
export const ZOTERO_TYPE_CSL: Readonly<Record<string, string>> = {
  preprint: "article",
  journalArticle: "article-journal",
  magazineArticle: "article-magazine",
  newspaperArticle: "article-newspaper",
  bill: "bill",
  book: "book",
  podcast: "broadcast",
  tvBroadcast: "broadcast",
  radioBroadcast: "broadcast",
  bookSection: "chapter",
  dataset: "dataset",
  document: "document",
  dictionaryEntry: "entry-dictionary",
  encyclopediaArticle: "entry-encyclopedia",
  artwork: "graphic",
  hearing: "hearing",
  interview: "interview",
  case: "legal_case",
  statute: "legislation",
  manuscript: "manuscript",
  map: "map",
  film: "motion_picture",
  videoRecording: "motion_picture",
  conferencePaper: "paper-conference",
  patent: "patent",
  letter: "personal_communication",
  email: "personal_communication",
  instantMessage: "personal_communication",
  forumPost: "post",
  blogPost: "post-weblog",
  report: "report",
  computerProgram: "software",
  audioRecording: "song",
  presentation: "speech",
  standard: "standard",
  thesis: "thesis",
  webpage: "webpage",
};

/** The source type of each Zotero item type that has one; the others are "other". */
export const ZOTERO_TYPE_SOURCE: Readonly<Record<string, ScientSourceType>> = {
  journalArticle: "article",
  magazineArticle: "article",
  newspaperArticle: "article",
  preprint: "preprint",
  book: "book",
  bookSection: "book-chapter",
  conferencePaper: "conference-paper",
  thesis: "thesis",
  report: "report",
  dataset: "dataset",
  webpage: "web",
  blogPost: "web",
  forumPost: "web",
  computerProgram: "software",
  presentation: "presentation",
  manuscript: "manuscript",
};
