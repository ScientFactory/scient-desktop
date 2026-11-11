// @effect-diagnostics nodeBuiltinImport:off -- The project citation style is plain project files beside the Promise-based Sources store.
// @effect-diagnostics globalDate:off -- The style setting keeps the interoperable ISO timestamp the store uses.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readCslStyle, renderableCslStyle } from "@scientfactory/scient-citations";
import {
  BUNDLED_CSL_STYLES,
  bundledCslStyleXml,
  parseCslStyleIndex,
  searchCslCatalog,
  type CslCatalogEntry,
} from "@scientfactory/scient-citations/catalog";
import { ScientSourceActor } from "@scientfactory/scient-sources";
import {
  assertScientProjectDirectory,
  publishScientProjectFile,
} from "@scientfactory/scient-sources/project-files";
import { canonicalizeScientSourceRoot } from "@scientfactory/scient-sources/store";
import {
  ScientCitationStyleId,
  type ScientCitationStyleSetResult,
  type ScientCitationStyleSummary,
  type ScientCitationStylesResult,
  type ScientProjectCitationStyle,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { METADATA_USER_AGENT, requestMetadata, type MetadataRequest } from "./metadataHttp.ts";

/** The project's chosen style and its files; never under `.scient/sources`. */
const CITATIONS_DIRECTORY = ".scient/citations";
const SETTING_FILE = "style.json";
const STYLES_DIRECTORY = "styles";

const INDEX_URL = "https://www.zotero.org/styles-files/styles.json";
const styleUrl = (id: string) => new URL(`https://www.zotero.org/styles/${id}`);
const INDEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** After a failed catalogue download, searches use what is at hand for this long. */
const INDEX_RETRY_MS = 60 * 1000;
const INDEX_LIMITS = { maxBytes: 16 * 1024 * 1024, timeoutMs: 30_000 };
const STYLE_LIMITS = { maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 };
const MAX_STYLE_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_LIMIT = 20;

const StyleName = Schema.Struct({ id: ScientCitationStyleId, title: Schema.String });
const StyleSetting = Schema.Struct({
  formatVersion: Schema.Literal(1),
  ...StyleName.fields,
  parent: Schema.NullOr(StyleName),
  updatedAt: Schema.String,
  updatedBy: ScientSourceActor,
});
type StyleSetting = typeof StyleSetting.Type;
const isCitationStyleId = Schema.is(ScientCitationStyleId);
const decodeSetting = Schema.decodeUnknownOption(Schema.fromJsonString(StyleSetting));

/** The downloaded catalogue lives in the server's state folder, not in any project. */
export function citationStyleCacheRoot(stateDir: string): string {
  return NodePath.join(stateDir, "scient", "citation-styles", "v1");
}

export interface CitationStyleDependencies {
  readonly request?: MetadataRequest;
  /** Server state folder for the downloaded catalogue; null keeps it in memory only. */
  readonly cacheRoot: string | null;
  readonly now?: () => number;
}

/** An expected failure, reported to the person or agent with this message. */
class CitationStyleError extends Schema.TaggedError<CitationStyleError>()("CitationStyleError", {
  message: Schema.String,
}) {}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

const styleFileName = (id: string) => `${STYLES_DIRECTORY}/${id}.csl`;

/** Null when the file is missing or cannot be read safely: a link, a folder, or too large. */
async function readCitationsFile(root: string, name: string): Promise<string | null> {
  const filePath = NodePath.join(root, CITATIONS_DIRECTORY, name);
  try {
    await assertScientProjectDirectory(root, NodePath.dirname(filePath));
    const stats = await NodeFSP.lstat(filePath);
    if (!stats.isFile() || stats.size > MAX_STYLE_FILE_BYTES) return null;
    return await NodeFSP.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function writeCitationsFile(root: string, name: string, contents: string): Promise<void> {
  const filePath = NodePath.join(root, CITATIONS_DIRECTORY, name);
  await assertScientProjectDirectory(root, NodePath.dirname(filePath), { create: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readCitationsFile(root, name);
    if (current === contents) return;
    const published = await publishScientProjectFile({ filePath, expected: current, contents });
    if (published.outcome === "written") return;
  }
  throw new CitationStyleError({
    message: `${CITATIONS_DIRECTORY}/${name} kept changing while Scient saved it.`,
  });
}

/**
 * The project's style and the XML to render it with. A style that is named but cannot be read
 * is reported, never replaced by another style.
 */
export async function readProjectCitationStyle(root: string): Promise<ScientProjectCitationStyle> {
  const canonicalRoot = await canonicalizeScientSourceRoot(root);
  const settingText = await readCitationsFile(canonicalRoot, SETTING_FILE);
  if (settingText === null) return { _tag: "none" };
  const setting = decodeSetting(settingText);
  if (setting._tag === "None") {
    return {
      _tag: "unavailable",
      id: "unknown",
      title: "The project's citation style",
      message: `${CITATIONS_DIRECTORY}/${SETTING_FILE} is not a citation style setting Scient can read.`,
    };
  }
  const { id, title, parent } = setting.value;
  const unavailable = (file: string, problem: "missing" | "invalid") =>
    ({
      _tag: "unavailable",
      id,
      title,
      message:
        problem === "missing"
          ? `${title} is missing from this project (${CITATIONS_DIRECTORY}/${file}).`
          : `${title} could not be read: ${CITATIONS_DIRECTORY}/${file} is not a CSL style.`,
    }) as const;
  const style = await readCitationsFile(canonicalRoot, styleFileName(id));
  if (style === null) return unavailable(styleFileName(id), "missing");
  const info = readCslStyle(style);
  if (info === null) return unavailable(styleFileName(id), "invalid");
  if (info.parentId === null) return { _tag: "ready", id, title, parent: null, xml: style };
  const parentId = parent?.id ?? info.parentId;
  const parentXml = await readCitationsFile(canonicalRoot, styleFileName(parentId));
  if (parentXml === null) return unavailable(styleFileName(parentId), "missing");
  const parentInfo = readCslStyle(parentXml);
  if (parentInfo === null || parentInfo.parentId !== null) {
    return unavailable(styleFileName(parentId), "invalid");
  }
  return {
    _tag: "ready",
    id,
    title,
    parent: { id: parentId, title: parentInfo.title },
    xml: renderableCslStyle(style, parentXml),
  };
}

interface CatalogueCache {
  entries: ReadonlyArray<CslCatalogEntry> | null;
  fetchedAt: number;
  failedAt: number;
  inFlight: Promise<void> | null;
}
const catalogue: CatalogueCache = { entries: null, fetchedAt: 0, failedAt: 0, inFlight: null };

/** Forgets the downloaded catalogue; for tests that record their own index. */
export function resetCitationStyleCatalogue(): void {
  Object.assign(catalogue, { entries: null, fetchedAt: 0, failedAt: 0, inFlight: null });
}

async function readCachedIndex(cacheRoot: string | null) {
  if (cacheRoot === null) return null;
  const filePath = NodePath.join(cacheRoot, "styles.json");
  try {
    const [text, stats] = await Promise.all([
      NodeFSP.readFile(filePath, "utf8"),
      NodeFSP.stat(filePath),
    ]);
    const entries = parseCslStyleIndex(JSON.parse(text));
    return entries === null ? null : { entries, fetchedAt: stats.mtimeMs };
  } catch {
    return null;
  }
}

async function writeCachedIndex(cacheRoot: string | null, text: string): Promise<void> {
  if (cacheRoot === null) return;
  await NodeFSP.mkdir(cacheRoot, { recursive: true });
  const filePath = NodePath.join(cacheRoot, "styles.json");
  const temporary = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await NodeFSP.rename(temporary, filePath);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

async function downloadIndex(deps: CitationStyleDependencies): Promise<void> {
  const request = deps.request ?? requestMetadata;
  const response = await request(
    new URL(INDEX_URL),
    { Accept: "application/json", "User-Agent": METADATA_USER_AGENT },
    INDEX_LIMITS,
  );
  if (response.status !== 200)
    throw new Error(`The style catalogue returned HTTP ${response.status}.`);
  const entries = parseCslStyleIndex(JSON.parse(response.body));
  if (entries === null) throw new Error("The style catalogue returned no styles.");
  catalogue.entries = entries;
  catalogue.fetchedAt = (deps.now ?? Date.now)();
  await writeCachedIndex(deps.cacheRoot, response.body).catch(() => undefined);
}

/** The catalogue to search: fresh, else the last one downloaded, else null (bundled only). */
async function catalogueEntries(deps: CitationStyleDependencies) {
  const now = (deps.now ?? Date.now)();
  if (catalogue.entries === null) {
    const cached = await readCachedIndex(deps.cacheRoot);
    if (cached) Object.assign(catalogue, cached);
  }
  const fresh = catalogue.entries !== null && now - catalogue.fetchedAt < INDEX_MAX_AGE_MS;
  if (!fresh && now - catalogue.failedAt >= INDEX_RETRY_MS) {
    catalogue.inFlight ??= downloadIndex(deps)
      .catch(() => {
        catalogue.failedAt = (deps.now ?? Date.now)();
      })
      .finally(() => {
        catalogue.inFlight = null;
      });
    await catalogue.inFlight;
  }
  const age = (deps.now ?? Date.now)() - catalogue.fetchedAt;
  return {
    entries: catalogue.entries,
    stale: catalogue.entries !== null && age >= INDEX_MAX_AGE_MS,
  };
}

const summary = (entry: CslCatalogEntry): ScientCitationStyleSummary => ({ ...entry });

export async function searchCitationStyles(
  input: { readonly root: string; readonly query?: string; readonly limit?: number },
  deps: CitationStyleDependencies,
): Promise<ScientCitationStylesResult> {
  const current = await readProjectCitationStyle(input.root);
  const query = input.query?.trim() ?? "";
  const limit = Math.min(SEARCH_LIMIT, Math.max(1, input.limit ?? SEARCH_LIMIT));
  if (query === "") {
    return {
      current,
      results: searchCslCatalog(BUNDLED_CSL_STYLES, "", limit).map(summary),
      catalogueMessage: null,
    };
  }
  const { entries, stale } = await catalogueEntries(deps);
  return {
    current,
    results: searchCslCatalog(entries ?? BUNDLED_CSL_STYLES, query, limit).map(summary),
    catalogueMessage:
      entries === null
        ? "The style catalogue could not be reached, so only the styles that come with Scient were searched."
        : stale
          ? "The style catalogue could not be reached; this search used the list Scient saved earlier."
          : null,
  };
}

async function styleXml(id: string, deps: CitationStyleDependencies): Promise<string> {
  const bundled = bundledCslStyleXml(id);
  if (bundled !== null) return bundled;
  const request = deps.request ?? requestMetadata;
  const response = await request(
    styleUrl(id),
    { Accept: "application/vnd.citationstyles.style+xml", "User-Agent": METADATA_USER_AGENT },
    STYLE_LIMITS,
  ).catch(() => null);
  if (response?.status === 404) {
    throw new CitationStyleError({ message: `No citation style has the ID ${id}.` });
  }
  if (response === null || response.status !== 200) {
    throw new CitationStyleError({
      message: `The citation style ${id} could not be downloaded. Check the network and try again, or choose a style that comes with Scient.`,
    });
  }
  return response.body;
}

/** Like `saveProjectCitationStyle`, reporting an expected failure beside the unchanged style. */
export async function setProjectCitationStyle(
  input: Parameters<typeof saveProjectCitationStyle>[0],
  deps: CitationStyleDependencies,
): Promise<ScientCitationStyleSetResult> {
  try {
    return { style: await saveProjectCitationStyle(input, deps), error: null };
  } catch (error) {
    if (!(error instanceof CitationStyleError)) throw error;
    return { style: await readProjectCitationStyle(input.root), error: error.message };
  }
}

/**
 * Saves a style into the project, with its parent when it is a dependent style, then names it
 * in `style.json`. Null clears the setting and leaves the style files in place.
 */
async function saveProjectCitationStyle(
  input: {
    readonly root: string;
    readonly styleId: string | null;
    readonly actor: ScientSourceActor;
  },
  deps: CitationStyleDependencies,
): Promise<ScientProjectCitationStyle> {
  const root = await canonicalizeScientSourceRoot(input.root);
  if (input.styleId === null) {
    const directory = NodePath.join(root, CITATIONS_DIRECTORY);
    try {
      await assertScientProjectDirectory(root, directory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { _tag: "none" };
      throw error;
    }
    await NodeFSP.rm(NodePath.join(directory, SETTING_FILE), { force: true });
    return { _tag: "none" };
  }
  if (!isCitationStyleId(input.styleId)) {
    throw new CitationStyleError({ message: `${input.styleId} is not a citation style ID.` });
  }
  const style = await styleXml(input.styleId, deps);
  const info = readCslStyle(style);
  if (info === null || info.id !== input.styleId) {
    throw new CitationStyleError({
      message: `The citation style ${input.styleId} is not a valid CSL style.`,
    });
  }
  let parent: { readonly id: string; readonly title: string; readonly xml: string } | null = null;
  if (info.parentId !== null) {
    const xml = await styleXml(info.parentId, deps);
    const parentInfo = readCslStyle(xml);
    if (parentInfo === null || parentInfo.parentId !== null || parentInfo.id !== info.parentId) {
      throw new CitationStyleError({
        message: `${info.title} uses ${info.parentId}, which is not a valid independent CSL style.`,
      });
    }
    parent = { id: parentInfo.id, title: parentInfo.title, xml };
  }
  if (parent) await writeCitationsFile(root, styleFileName(parent.id), parent.xml);
  await writeCitationsFile(root, styleFileName(info.id), style);
  const setting: StyleSetting = {
    formatVersion: 1,
    id: info.id,
    title: info.title,
    parent: parent ? { id: parent.id, title: parent.title } : null,
    updatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    updatedBy: input.actor,
  };
  await writeCitationsFile(root, SETTING_FILE, `${JSON.stringify(setting, null, 2)}\n`);
  return readProjectCitationStyle(root);
}
