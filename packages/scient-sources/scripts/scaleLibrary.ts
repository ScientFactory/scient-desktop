// @effect-diagnostics nodeBuiltinImport:off -- A measurement fixture that writes real library and project folders.
// @effect-diagnostics globalDate:off globalConsole:off -- Fixed timestamps for the seeded files, and a printed summary.
/**
 * The scale gate's test Library from a seed: record, PDF, text, highlight and collection bytes
 * are the same on every platform; IDs and times the store assigns itself are not.
 *   node scripts/scaleLibrary.ts --out <empty folder> [--seed 20261112] [--records 20000] [--move]
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { initializeScientProject } from "@scientfactory/project-init";

import { mergeScientLibraryDuplicates, mergeScientLibrarySources } from "../src/libraryMerge.ts";
import { changeScientLibraryReview } from "../src/libraryReviews.ts";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
  type ScientLibraryLocation,
  type ScientSourceStoreLocation,
} from "../src/libraryRoot.ts";
import type { ScientSourceCandidate, ScientSourceRecord, ScientSourceType } from "../src/model.ts";
import { changeScientProjectPins, resolveScientProjectPins } from "../src/projectPins.ts";
import {
  attachScientSourcePdf,
  importScientSource,
  readScientSourceRecord,
  SCIENT_SOURCES_DIRECTORY,
} from "../src/store.ts";
import { changeScientSystematicReview } from "../src/systematicReviewStore.ts";

export const SCALE_SEED = 20_261_112;

export interface ScaleOptions {
  readonly seed?: number;
  /** Live records once the generated duplicates are merged. */
  readonly records?: number;
}

/** mulberry32: small, fast and the same on every platform. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WORDS = (
  "patients randomised trial outcome mortality sepsis therapy early intervention control group " +
  "hazard ratio interval endpoint hospital admission intensive care fluid vasopressor lactate " +
  "cohort baseline follow-up neural network model learning protein structure prediction gene " +
  "expression cell signalling pathway inhibitor receptor binding affinity cortex hippocampus " +
  "memory consolidation sleep spindle oscillation synaptic plasticity dopamine reward learning " +
  "climate warming precipitation drought ecosystem carbon flux soil nitrogen biodiversity " +
  "species abundance population dynamics graph theorem proof bound algorithm complexity " +
  "approximation convex optimisation stochastic gradient variance estimator bayesian inference " +
  "posterior sampling markov chain monte carlo regression causal effect confounding " +
  "instrumental variable meta-analysis heterogeneity bias sensitivity specificity diagnostic " +
  "accuracy imaging resonance tomography segmentation classifier transformer attention " +
  "language corpus annotation benchmark evaluation robustness adversarial privacy federated " +
  "quantum entanglement qubit error correction lattice spin superconducting phase transition " +
  "material catalyst electrode battery lithium polymer thin film spectroscopy microscopy"
).split(" ");
const GIVEN = (
  "Ada Alan Amira Ana Anders Aiko Bao Beatriz Carlos Chen Chiara Daniel David Dmitri Elena " +
  "Emma Fatima Felix Gabriel Hana Hiroshi Ines Ivan Jae James Jia Johan Julia Kai Kenji Lars " +
  "Laura Leila Li Lucas Maria Marta Mei Miguel Nadia Nikolai Noah Olga Omar Paulo Priya Rahul " +
  "Rosa Sara Sofia Sven Tariq Tomas Uma Victor Wei Yara Yusuf Zoe"
).split(" ");
const FAMILY = (
  "Smith Garcia Müller Wang Li Zhang Kim Nguyen Rossi Silva Santos Kowalski Novak Ivanov " +
  "Petrov Tanaka Suzuki Sato Yamamoto Cohen Levi Haddad Khan Patel Singh Gupta Sharma Okafor " +
  "Mensah Andersen Johansson Nielsen Virtanen Dubois Martin Bernard Moreau Fischer Weber " +
  "Schmidt Becker Romano Ricci Costa Ferreira Lopez Martinez Hernandez Gonzalez Perez Brown " +
  "Taylor Wilson Davies Evans Thomas Roberts Walker Wright Clarke Hughes Edwards O'Brien Murphy " +
  "Kelly Ryan Byrne Lindqvist Berg Hansen Jensen Larsen Kaur Chowdhury Rahman Ahmed Hassan Ali"
).split(" ");
const JOURNAL_HEADS = ["Journal of", "Annals of", "Advances in", "Reviews in", "Frontiers in"];
const TAG_WORDS = WORDS.filter((word) => word.length > 4).slice(0, 150);
const TYPES: ReadonlyArray<readonly [ScientSourceType, number]> = [
  ["article", 0.7],
  ["preprint", 0.08],
  ["conference-paper", 0.07],
  ["book-chapter", 0.05],
  ["book", 0.04],
  ["thesis", 0.02],
  ["report", 0.02],
  ["dataset", 0.01],
  ["web", 0.01],
];

const sha256 = (bytes: Buffer | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

interface Rng {
  readonly next: () => number;
  readonly int: (min: number, max: number) => number;
  readonly pick: <A>(values: ReadonlyArray<A>) => A;
  readonly words: (count: number) => string;
}

function rng(seed: number): Rng {
  const next = random(seed);
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <A>(values: ReadonlyArray<A>) => values[Math.floor(next() * values.length)]!;
  const words = (count: number) => Array.from({ length: count }, () => pick(WORDS)).join(" ");
  return { next, int, pick, words };
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function sentences(r: Rng, characters: number): string {
  const parts: string[] = [];
  let length = 0;
  while (length < characters) {
    const sentence = `${capitalize(r.words(r.int(9, 22)))}.`;
    parts.push(sentence);
    length += sentence.length + 1;
  }
  return parts.join(" ");
}

const JOURNALS = (() => {
  const r = rng(7);
  return Array.from(
    { length: 400 },
    (_, index) => `${r.pick(JOURNAL_HEADS)} ${capitalize(r.words(r.int(1, 3)))} ${index}`,
  );
})();

/** The bibliographic content of work `index`; the same work in every store layout. */
export interface ScaleWork {
  readonly fields: Omit<
    ScientSourceCandidate,
    "sourceKey" | "pdfAvailable" | "pdfFileName" | "pdfAttachmentCount"
  > & {
    readonly abstractSections?: ReadonlyArray<{
      readonly title: string | null;
      readonly paragraphs: ReadonlyArray<string>;
    }>;
  };
  readonly citationKey: string;
  readonly importedAt: string;
  readonly readingStatus: "read" | "unread";
  readonly starred: boolean;
}

function work(seed: number, index: number): ScaleWork {
  const r = rng(seed * 1_000_003 + index);
  let roll = r.next();
  let type: ScientSourceType = "other";
  for (const [candidate, weight] of TYPES) {
    if (roll < weight) {
      type = candidate;
      break;
    }
    roll -= weight;
  }
  const year = Math.min(2026, 1965 + Math.floor(61 * Math.sqrt(r.next())));
  const authors = Math.max(1, Math.min(14, Math.round(-Math.log(1 - r.next()) * 4)));
  const creators = Array.from({ length: authors }, () =>
    r.next() < 0.01
      ? {
          creatorType: "author" as const,
          givenName: null,
          familyName: null,
          literalName: `${capitalize(r.words(2))} Consortium`,
        }
      : {
          creatorType: "author" as const,
          givenName: r.pick(GIVEN),
          familyName: r.pick(FAMILY),
          literalName: null,
        },
  );
  const title = `${capitalize(r.words(r.int(6, 16)))} (${index})`;
  const journal = r.pick(JOURNALS);
  const identifiers: Array<{ scheme: string; value: string }> = [];
  if (r.next() < 0.85 && type !== "book") {
    identifiers.push({
      scheme: "doi",
      value: `10.${r.int(1_000, 99_999)}/${journal.split(" ").at(-1)}.${year}.${index}`,
    });
  }
  if (type === "article" && r.next() < 0.4)
    identifiers.push({ scheme: "pmid", value: String(10_000_000 + index) });
  if (type === "preprint")
    identifiers.push({ scheme: "arxiv", value: `${String(year).slice(2)}01.${10_000 + index}` });
  if (type === "book" || type === "book-chapter") {
    identifiers.push({ scheme: "isbn", value: `978${String(1_000_000_000 + index).slice(0, 10)}` });
  }
  const abstract = sentences(r, r.int(1_200, 1_800));
  const structured = type === "article" && r.next() < 0.6;
  const abstractSections = structured
    ? ["Background", "Methods", "Results", "Conclusions"].map((heading, part, all) => {
        const size = Math.ceil(abstract.length / all.length);
        return {
          title: heading,
          paragraphs: [abstract.slice(part * size, (part + 1) * size).trim() || heading],
        };
      })
    : undefined;
  const tagCount = Math.min(6, Math.floor(-Math.log(1 - r.next()) * 1.6));
  const tags = [
    ...new Set(
      Array.from(
        { length: tagCount },
        () => TAG_WORDS[Math.floor(TAG_WORDS.length * r.next() ** 2)]!,
      ),
    ),
  ];
  const lead = creators[0]!;
  const keyName = (lead.familyName ?? lead.literalName ?? "anon")
    .toLowerCase()
    .replaceAll(/[^a-z]/gu, "");
  const container =
    type === "article"
      ? journal
      : type === "conference-paper"
        ? `Proceedings of the ${capitalize(r.words(2))} Conference ${year}`
        : type === "book-chapter"
          ? capitalize(r.words(4))
          : null;
  return {
    fields: {
      type,
      customType: null,
      title,
      creators,
      issuedRaw: r.next() < 0.3 ? `${year}-${String(r.int(1, 12)).padStart(2, "0")}` : String(year),
      issuedYear: year,
      identifiers,
      abstract,
      ...(abstractSections ? { abstractSections } : {}),
      containerTitle: container,
      publisher: type === "book" || type === "report" ? `${capitalize(r.words(1))} Press` : null,
      volume: type === "article" ? String(r.int(1, 120)) : null,
      issue: type === "article" ? String(r.int(1, 12)) : null,
      pages: type === "article" ? `${r.int(1, 900)}-${r.int(901, 1_800)}` : null,
      language: r.next() < 0.95 ? "en" : "de",
      url: r.next() < 0.3 ? `https://example.org/works/${index}` : null,
      tags,
      externalReferences: [],
      fieldProvenance: [],
    },
    citationKey: `${keyName || "anon"}${year}${index}`,
    importedAt: new Date(Date.UTC(2019, 0, 1) + index * 4_321_000).toISOString(),
    readingStatus: r.next() < 0.3 ? "read" : "unread",
    starred: r.next() < 0.05,
  };
}

/** A small valid-looking PDF and its extracted text, from the work's index. */
function pdfAndText(seed: number, index: number) {
  const r = rng(seed * 7_919 + index);
  const pages = Array.from({ length: r.int(6, 14) }, () => sentences(r, r.int(2_800, 4_200)));
  const bytes = Buffer.from(
    `%PDF-1.7\n% scale gate ${seed} ${index}\n${pages
      .map(
        (text, page) =>
          `${page + 1} 0 obj\n<< /Length ${text.length} >>\nstream\n${text.slice(0, 600)}\nendstream\nendobj\n`,
      )
      .join("")}%%EOF\n`,
  );
  const hash = sha256(bytes);
  const text = {
    formatVersion: 1,
    outcome: "extracted",
    sha256: hash,
    byteLength: bytes.length,
    profile: "pdfjs-text-layer-utf16-eol-v1",
    extractor: { name: "pdfjs", version: "5.4.149" },
    extractedAt: "2026-01-01T00:00:00.000Z",
    pageCount: pages.length,
    complete: true,
    pages: pages.map((pageText, page) => ({
      page: page + 1,
      text: pageText,
      viewBox: [0, 0, 612, 792],
      rotation: 0,
      userUnit: 1,
    })),
  };
  return { bytes, hash, text, pages, r };
}

/** One to five highlights on the PDF, as the reader stores them. */
function highlights(
  seed: number,
  index: number,
  material: { sha256: string; byteLength: number },
  pages: ReadonlyArray<string>,
  pathHint: string,
) {
  const r = rng(seed * 104_729 + index);
  const annotations = Array.from({ length: r.int(1, 5) }, (_, number) => {
    const page = r.int(1, pages.length);
    const text = pages[page - 1]!;
    const start = r.int(0, Math.max(0, text.length - 200));
    const quote = text.slice(start, start + r.int(40, 180)).trimEnd() || text.slice(0, 40);
    const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000 + number * 1_000).toISOString();
    return {
      annotationId: `ann_${sha256(`${seed}:${index}:${number}`).slice(0, 24)}`,
      revision: 1,
      anchor: {
        extractor: { profile: "pdfjs-text-layer-utf16-eol-v1", version: "5.4.149" },
        selector: {
          type: "text",
          pages: [
            {
              page,
              viewBox: [0, 0, 612, 792],
              rotation: 0,
              userUnit: 1,
              pageTextHash: sha256(text),
              start,
              end: start + quote.length,
              quote,
              prefix: text.slice(Math.max(0, start - 32), start),
              suffix: text.slice(start + quote.length, start + quote.length + 32),
            },
          ],
        },
      },
      highlighted: true,
      note: r.next() < 0.3 ? sentences(r, 120) : "",
      createdAt: at,
      createdBy: "user",
      updatedAt: at,
      updatedBy: "user",
      deletedAt: null,
    };
  });
  return { formatVersion: 1, material, paths: [pathHint], annotations, history: [] };
}

async function writeJson(filePath: string, value: unknown, pretty = true): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  await NodeFSP.writeFile(
    filePath,
    pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value),
    "utf8",
  );
}

/** The candidate one real import needs, so the template carries every field the store writes. */
const templateCandidate = (seed: number): ScientSourceCandidate => {
  const { fields } = work(seed, 0);
  const { abstractSections: _sections, ...rest } = fields;
  return {
    ...rest,
    sourceKey: "scale-template",
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
};

/** One real import and PDF attach as the template; the store's own fields come from it. */
async function template(location: ScientSourceStoreLocation, base: string, seed: number) {
  const first = (
    await importScientSource({
      root: location,
      operationId: `op_${sha256(`template:${seed}`).slice(0, 32)}`,
      candidate: templateCandidate(seed),
      actor: "user",
      intake: "file",
    })
  ).record!;
  const pdfPath = NodePath.join(base, "template.pdf");
  await NodeFSP.writeFile(pdfPath, "%PDF-1.7\ntemplate\n%%EOF\n");
  await attachScientSourcePdf({
    root: location,
    sourceId: first.sourceId,
    expectedRevision: first.revision,
    pdfPath,
  });
  const record = (await readScientSourceRecord(location, first.sourceId))!;
  return { record, attachment: record.attachments[0]! };
}

interface Layout {
  /** Folder holding records/, files/, text/. */
  readonly store: string;
  /** Folder holding highlight files. */
  readonly annotations: string;
  /** How a highlight file names the PDF's path (a hint only). */
  readonly pathHint: (relativePath: string) => string;
  readonly formatVersion: 1 | 2;
  readonly projectId?: string;
}

interface Planned {
  /** Index of the work this record repeats, for the generated duplicates. */
  readonly copyOf?: number;
  readonly kind?: "possible" | "automatic";
}

/**
 * The records of a store: `live` distinct works, then `possible` copies that only look alike
 * (title, lead author, year; no identifier) and `automatic` copies that share a DOI.
 */
async function writeRecords(input: {
  readonly seed: number;
  readonly layout: Layout;
  readonly template: Awaited<ReturnType<typeof template>>;
  readonly live: number;
  readonly possible: number;
  readonly automatic: number;
  readonly pdfs: number;
  readonly highlighted: number;
}): Promise<{
  readonly sourceIds: string[];
  readonly possiblePairs: Array<readonly [string, string]>;
  readonly automaticPairs: Array<readonly [string, string]>;
  readonly pdfSourceIds: string[];
}> {
  const { seed, layout } = input;
  const prefix = input.template.record.sourceId.split("_")[0]!;
  const recordsDirectory = NodePath.join(layout.store, "records");
  await NodeFSP.mkdir(recordsDirectory, { recursive: true });
  // Copies repeat even (looks alike) or odd (same DOI) works, never the template, never each other.
  const span = input.live - 8;
  const plan: Planned[] = [
    ...Array.from({ length: input.live }, () => ({})),
    ...Array.from({ length: input.possible }, (_, number) => ({
      copyOf: 2 + 2 * Math.floor((number * span) / (2 * input.possible)),
      kind: "possible" as const,
    })),
    ...Array.from({ length: input.automatic }, (_, number) => {
      // The next odd work with a DOI, so every copy shares one with its original.
      let copyOf = 3 + 2 * Math.floor((number * span) / (2 * input.automatic));
      while (!work(seed, copyOf).fields.identifiers.some(({ scheme }) => scheme === "doi")) {
        copyOf += 2;
      }
      return { copyOf, kind: "automatic" as const };
    }),
  ];
  const pdfIndexes = new Set(
    Array.from(
      { length: input.pdfs },
      (_, number) => 1 + Math.floor((number * (input.live - 1)) / input.pdfs),
    ),
  );
  const sourceIds: string[] = [];
  const possiblePairs: Array<readonly [string, string]> = [];
  const automaticPairs: Array<readonly [string, string]> = [];
  const pdfSourceIds: string[] = [];
  const { record: base, attachment } = input.template;
  for (const [index, planned] of plan.entries()) {
    const sourceId =
      index === 0 ? base.sourceId : `${prefix}_${sha256(`scale:${seed}:${index}`).slice(0, 32)}`;
    const own = work(seed, index);
    const original = planned.copyOf === undefined ? own : work(seed, planned.copyOf);
    const fields =
      planned.kind === "possible"
        ? {
            ...own.fields,
            title: original.fields.title,
            creators: original.fields.creators,
            issuedYear: original.fields.issuedYear,
            issuedRaw: original.fields.issuedRaw,
            identifiers: [],
            containerTitle: "Another listing of the same work",
          }
        : planned.kind === "automatic"
          ? {
              ...own.fields,
              title: `${original.fields.title}.`,
              identifiers: original.fields.identifiers.filter(({ scheme }) => scheme === "doi"),
            }
          : own.fields;
    const hasPdf = pdfIndexes.has(index);
    let attachments: ScientSourceRecord["attachments"] = [];
    if (hasPdf) {
      const pdf = pdfAndText(seed, index);
      const relativePath = `files/sha256/${pdf.hash.slice(0, 2)}/${pdf.hash}.pdf`;
      const pdfPath = NodePath.join(layout.store, ...relativePath.split("/"));
      await NodeFSP.mkdir(NodePath.dirname(pdfPath), { recursive: true });
      await NodeFSP.writeFile(pdfPath, pdf.bytes);
      await writeJson(
        NodePath.join(layout.store, "text", "sha256", pdf.hash.slice(0, 2), `${pdf.hash}.json`),
        pdf.text,
        false,
      );
      if (pdfSourceIds.length < input.highlighted) {
        await writeJson(
          NodePath.join(layout.annotations, `${pdf.hash}.json`),
          highlights(
            seed,
            index,
            { sha256: pdf.hash, byteLength: pdf.bytes.length },
            pdf.pages,
            layout.pathHint(relativePath),
          ),
        );
      }
      attachments = [
        {
          ...attachment,
          sha256: pdf.hash,
          byteLength: pdf.bytes.length,
          relativePath,
          attachmentId: `pdf_${sha256(`attachment:${seed}:${index}`).slice(0, 32)}`,
          fileName: `${own.citationKey}.pdf`,
          importedAt: own.importedAt,
        },
      ];
      pdfSourceIds.push(sourceId);
    }
    const record = {
      ...base,
      ...fields,
      formatVersion: layout.formatVersion,
      ...(layout.projectId ? { projectId: layout.projectId } : {}),
      sourceId,
      revision: index === 0 ? base.revision : 1,
      citationKey: own.citationKey,
      attachments,
      origin: {
        ...base.origin!,
        operationId: `op_${sha256(`scale-op:${seed}:${index}`).slice(0, 32)}`,
      },
      importedAt: own.importedAt,
      updatedAt: own.importedAt,
      ...(layout.formatVersion === 2
        ? { readingStatus: own.readingStatus, starred: own.starred }
        : {}),
    };
    if (!("abstractSections" in fields))
      delete (record as { abstractSections?: unknown }).abstractSections;
    await writeJson(NodePath.join(recordsDirectory, `${sourceId}.json`), record);
    sourceIds.push(sourceId);
    if (planned.copyOf !== undefined) {
      const pair = [sourceIds[planned.copyOf]!, sourceId] as const;
      (planned.kind === "possible" ? possiblePairs : automaticPairs).push(pair);
    }
  }
  return { sourceIds, possiblePairs, automaticPairs, pdfSourceIds };
}

/** A few hundred collections, one level of nesting, from 5 to 2,000 members each. */
function collections(seed: number, sourceIds: ReadonlyArray<string>, count: number) {
  const r = rng(seed * 31 + 1);
  const parents = Math.round(count / 5);
  return Array.from({ length: count }, (_, index) => {
    const size = Math.round(Math.exp(r.next() * Math.log(400)) * 5);
    const start = r.int(0, Math.max(0, sourceIds.length - size));
    const at = new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString();
    return {
      collectionId: `collection_${sha256(`collection:${seed}:${index}`).slice(0, 32)}`,
      name: `${capitalize(r.words(r.int(1, 3)))} ${index}`,
      ...(index >= parents
        ? {
            parentCollectionId: `collection_${sha256(`collection:${seed}:${index % parents}`).slice(0, 32)}`,
          }
        : {}),
      sourceIds: sourceIds.slice(start, start + size),
      createdAt: at,
      updatedAt: at,
      updatedBy: "user" as const,
    };
  });
}

const SAVED_SEARCHES = [
  { name: "Unread trials", filter: { text: "randomised trial" } },
  { name: "Sepsis with PDF", filter: { text: "sepsis", hasPdf: true } },
  { name: "Preprints", filter: { type: "preprint" } },
  { name: "Tagged learning", filter: { tags: ["learning"] } },
  { name: "Books", filter: { type: "book" } },
] as const;

async function folderSize(folder: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const entries = await NodeFSP.readdir(folder, { withFileTypes: true, recursive: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += (await NodeFSP.stat(NodePath.join(entry.parentPath, entry.name))).size;
  }
  return { files, bytes };
}

export interface ScaleLibrary {
  readonly stateDir: string;
  readonly libraryRoot: string;
  readonly library: ScientLibraryLocation;
  /** Three registered checkouts; `thesis` holds the 10,000-record review. */
  readonly projects: { readonly thesis: string; readonly grant: string; readonly paper: string };
  readonly reviewId: string;
  readonly sourceIds: ReadonlyArray<string>;
  /** Library IDs pinned by each checkout. */
  readonly pinned: {
    readonly thesis: ReadonlyArray<string>;
    readonly grant: ReadonlyArray<string>;
    readonly paper: ReadonlyArray<string>;
  };
  readonly collectionIds: ReadonlyArray<string>;
  readonly generated: Record<string, unknown>;
}

/** The personal Library at `<base>/state/scient/library`, with three checkouts under `<base>/projects`. */
export async function buildScaleLibrary(
  base: string,
  options: ScaleOptions = {},
): Promise<ScaleLibrary> {
  const seed = options.seed ?? SCALE_SEED;
  const live = options.records ?? 20_000;
  const scale = live / 20_000;
  const started = performance.now();
  const stateDir = NodePath.join(base, "state");
  const libraryRoot = scientLibraryRootFor(stateDir);
  await ensureScientLibrary(libraryRoot);
  const library = scientLibraryLocation(libraryRoot);
  const automatic = Math.round(60 * scale);
  const requested = Math.round(40 * scale);
  const possible = Math.round(400 * scale) + requested;
  const written = await writeRecords({
    seed,
    layout: {
      store: libraryRoot,
      annotations: NodePath.join(libraryRoot, "annotations", "v1"),
      pathHint: (relativePath) => `${SCIENT_SOURCES_DIRECTORY}/${relativePath}`,
      formatVersion: 2,
    },
    template: await template(library, base, seed),
    // Distinct works, so that `live` remain once the copies are merged away.
    live: live - possible + requested,
    possible,
    automatic,
    pdfs: Math.round(live / 4),
    highlighted: Math.round(live / 20),
  });
  const writtenAt = performance.now();
  // Merged-away copies go to the trash; the live list is the rest.
  const automaticPass = await mergeScientLibraryDuplicates({ library, actor: "user" });
  for (const pair of written.possiblePairs.slice(0, requested)) {
    await mergeScientLibrarySources({ library, sourceIds: pair, actor: "user" });
  }
  const mergedAway = new Set([
    ...written.automaticPairs.map(([, loser]) => loser),
    ...written.possiblePairs.slice(0, requested).map(([, loser]) => loser),
  ]);
  const liveIds = written.sourceIds.filter((sourceId) => !mergedAway.has(sourceId));
  const mergedAt = performance.now();

  const all = collections(seed, liveIds, Math.round(300 * Math.max(scale, 0.1)));
  for (const collection of all) {
    await writeJson(NodePath.join(libraryRoot, "collections", `${collection.collectionId}.json`), {
      formatVersion: 2,
      ...collection,
    });
  }
  await writeJson(NodePath.join(libraryRoot, "saved-searches.json"), {
    formatVersion: 2,
    savedSearches: SAVED_SEARCHES.map((search, index) => ({
      searchId: `search_${sha256(`search:${seed}:${index}`).slice(0, 32)}`,
      ...search,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: "user",
    })),
  });

  // Three checkouts: overlapping pins, the first with the 10,000-record review.
  const shuffled = (() => {
    const r = rng(seed * 13 + 5);
    const ids = [...liveIds];
    for (let index = ids.length - 1; index > 0; index -= 1) {
      const other = Math.floor(r.next() * (index + 1));
      [ids[index], ids[other]] = [ids[other]!, ids[index]!];
    }
    return ids;
  })();
  const n = (count: number) => Math.round(count * scale);
  const pinned = {
    thesis: shuffled.slice(0, n(5_000)),
    grant: shuffled.slice(n(4_000), n(7_000)),
    paper: shuffled.slice(n(6_500), n(7_500)),
  };
  const projects = {
    thesis: NodePath.join(base, "projects", "thesis"),
    grant: NodePath.join(base, "projects", "grant"),
    paper: NodePath.join(base, "projects", "paper"),
  };
  for (const name of ["thesis", "grant", "paper"] as const) {
    const projectRoot = projects[name];
    await NodeFSP.mkdir(projectRoot, { recursive: true });
    await initializeScientProject({ root: projectRoot });
    await changeScientProjectPins({
      projectRoot,
      library,
      changes: pinned[name].map((sourceId) => ({ action: "pin" as const, sourceId })),
      actor: "user",
    });
    await resolveScientProjectPins({ projectRoot, library, mode: "write", actor: "user" });
  }
  const pinnedAt = performance.now();

  const reviewIds = [...pinned.thesis, ...shuffled.slice(n(7_500), n(12_500))];
  const { reviewId } = await changeScientLibraryReview({
    projectRoot: projects.thesis,
    library,
    change: { action: "create-review", title: "Early fluids in sepsis" },
    actor: "user",
  });
  await changeScientLibraryReview({
    projectRoot: projects.thesis,
    library,
    change: {
      action: "log-search",
      reviewId: reviewId!,
      database: "PubMed",
      query: "sepsis AND fluid",
      searchedOn: "2026-10-01",
      resultCount: reviewIds.length,
      sourceIds: reviewIds,
    },
    actor: "user",
  });
  const screened = reviewIds.slice(0, n(2_000));
  for (let start = 0; start < screened.length; start += 500) {
    await changeScientLibraryReview({
      projectRoot: projects.thesis,
      library,
      change: {
        action: "screen",
        reviewId: reviewId!,
        stage: "title-abstract",
        decisions: screened.slice(start, start + 500).map((sourceId, index) => ({
          sourceId,
          decision: index % 4 === 0 ? ("exclude" as const) : ("include" as const),
        })),
      },
      actor: "user",
    });
  }
  const reviewedAt = performance.now();

  const reviewFolder = NodePath.join(projects.thesis, ".scient", "library", "reviews");
  const generated = {
    seed,
    liveRecords: liveIds.length,
    writtenRecords: written.sourceIds.length,
    pdfs: written.pdfSourceIds.length,
    automaticMerges: automaticPass.mergedCount,
    requestedMerges: requested,
    possiblePairsLeft: possible - requested,
    collections: all.length,
    nestedCollections: all.filter((collection) => "parentCollectionId" in collection).length,
    savedSearches: SAVED_SEARCHES.length,
    pins: { thesis: pinned.thesis.length, grant: pinned.grant.length, paper: pinned.paper.length },
    reviewRecords: reviewIds.length,
    screened: screened.length,
    sizes: {
      library: await folderSize(libraryRoot),
      records: await folderSize(NodePath.join(libraryRoot, "records")),
      pdfs: await folderSize(NodePath.join(libraryRoot, "files")),
      text: await folderSize(NodePath.join(libraryRoot, "text")),
      highlights: await folderSize(NodePath.join(libraryRoot, "annotations")),
      trash: await folderSize(NodePath.join(libraryRoot, "trash")),
      collections: await folderSize(NodePath.join(libraryRoot, "collections")),
      thesisReviews: await folderSize(reviewFolder),
      reviewSnapshotSharded: (await NodeFSP.readdir(reviewFolder)).some((name) =>
        name.endsWith(".works"),
      ),
    },
    recordsDigest: await folderDigest(NodePath.join(libraryRoot, "records"), new Set(mergedAway)),
    ms: {
      write: Math.round(writtenAt - started),
      merges: Math.round(mergedAt - writtenAt),
      pins: Math.round(pinnedAt - mergedAt),
      review: Math.round(reviewedAt - pinnedAt),
    },
  };
  return {
    stateDir,
    libraryRoot,
    library,
    projects,
    reviewId: reviewId!,
    sourceIds: liveIds,
    pinned,
    collectionIds: all.map((collection) => collection.collectionId),
    generated,
  };
}

/**
 * The SHA-256 of the seeded record files, by name, leaving out the template (its import time is
 * the clock's) and the records the merges rewrote. Equal on every platform for one seed.
 */
async function folderDigest(folder: string, skip: ReadonlySet<string>): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  const names = (await NodeFSP.readdir(folder)).filter((name) => name.endsWith(".json")).toSorted();
  for (const name of names) {
    const bytes = await NodeFSP.readFile(NodePath.join(folder, name));
    const record = JSON.parse(bytes.toString("utf8")) as { revision: number; sourceId: string };
    if (record.revision !== 1 || skip.has(record.sourceId)) continue;
    hash.update(name).update(bytes);
  }
  return hash.digest("hex");
}

export interface ScaleMoveProject {
  readonly root: string;
  readonly generated: Record<string, unknown>;
}

/**
 * A v1 project of `records` sources to move into an empty library: a quarter with PDFs and text,
 * highlights, 50 collections, a 10,000-record review with screening, and 100 DOI copies for the
 * move's merge pass.
 */
export async function buildScaleMoveProject(
  base: string,
  options: ScaleOptions = {},
): Promise<ScaleMoveProject> {
  const seed = (options.seed ?? SCALE_SEED) + 1;
  const records = options.records ?? 20_000;
  const scale = records / 20_000;
  const started = performance.now();
  const root = NodePath.join(base, "move-project");
  await NodeFSP.mkdir(root, { recursive: true });
  await initializeScientProject({ root });
  const first = await template(root, base, seed);
  const store = NodePath.join(root, ...SCIENT_SOURCES_DIRECTORY.split("/"));
  const automatic = Math.round(100 * scale);
  const written = await writeRecords({
    seed,
    layout: {
      store,
      annotations: NodePath.join(root, ".scient", "annotations", "v1"),
      pathHint: (relativePath) => `${SCIENT_SOURCES_DIRECTORY}/${relativePath}`,
      formatVersion: 1,
      projectId: first.record.projectId!,
    },
    template: first,
    live: records,
    possible: 0,
    automatic,
    pdfs: Math.round(records / 4),
    highlighted: Math.round(records / 20),
  });
  const all = collections(seed, written.sourceIds, Math.max(5, Math.round(50 * scale)));
  await writeJson(NodePath.join(store, "collections.json"), {
    formatVersion: 1,
    collections: all,
    savedSearches: [],
  });
  const reviewIds = written.sourceIds.slice(0, Math.round(10_000 * scale));
  const { reviewId } = await changeScientSystematicReview({
    root,
    change: { action: "create-review", title: "Early fluids in sepsis" },
    actor: "user",
  });
  await changeScientSystematicReview({
    root,
    change: {
      action: "log-search",
      reviewId: reviewId!,
      database: "PubMed",
      query: "sepsis AND fluid",
      searchedOn: "2026-10-01",
      sourceIds: reviewIds,
    },
    actor: "user",
  });
  for (let start = 0; start < Math.round(2_000 * scale); start += 500) {
    await changeScientSystematicReview({
      root,
      change: {
        action: "screen",
        reviewId: reviewId!,
        stage: "title-abstract",
        decisions: reviewIds.slice(start, start + 500).map((sourceId, index) => ({
          sourceId,
          decision: index % 4 === 0 ? ("exclude" as const) : ("include" as const),
        })),
      },
      actor: "user",
    });
  }
  return {
    root,
    generated: {
      seed,
      records: written.sourceIds.length,
      pdfs: written.pdfSourceIds.length,
      doiCopies: written.automaticPairs.length,
      collections: all.length,
      reviewRecords: reviewIds.length,
      sizes: {
        store: await folderSize(store),
        highlights: await folderSize(NodePath.join(root, ".scient", "annotations")),
      },
      ms: Math.round(performance.now() - started),
    },
  };
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      out: { type: "string" },
      seed: { type: "string", default: String(SCALE_SEED) },
      records: { type: "string", default: "20000" },
      move: { type: "boolean", default: false },
    },
  });
  if (!values.out) throw new Error("Give --out <empty folder>.");
  const out = NodePath.resolve(values.out);
  await NodeFSP.mkdir(out, { recursive: true });
  const options = {
    seed: Number.parseInt(values.seed, 10),
    records: Number.parseInt(values.records, 10),
  };
  const built = await buildScaleLibrary(out, options);
  const move = values.move ? await buildScaleMoveProject(out, options) : null;
  console.log(
    JSON.stringify(
      { library: built.generated, ...(move ? { move: move.generated } : {}) },
      null,
      2,
    ),
  );
}
