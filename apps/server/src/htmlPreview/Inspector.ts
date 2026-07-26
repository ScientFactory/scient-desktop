// FILE: Inspector.ts
// Purpose: Classify local HTML artifacts before any executable preview capability is issued.
// Layer: Server HTML-preview domain logic

import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

import type {
  ProjectHtmlArtifactRunTarget,
  ProjectHtmlArtifactWarning,
  ProjectInspectHtmlArtifactInput,
  ProjectInspectHtmlArtifactResult,
} from "@synara/contracts";
import { init as initializeModuleLexer, parse as parseModuleImports } from "es-module-lexer";
import { isSupportedLocalHtmlPath, lowerCaseExtensionOf } from "@synara/shared/localPreviewFiles";
import { parse, type DefaultTreeAdapterMap } from "parse5";

import { commandForProjectPackageScript, detectProjectPackageManager } from "../workspaceEntries";

const HTML_INSPECTION_MAX_BYTES = 1_000_000;
const PACKAGE_JSON_MAX_BYTES = 1_000_000;
const MAX_WARNINGS = 20;
const RESOURCE_GRAPH_MAX_FILES = 250;
const RESOURCE_GRAPH_PARSE_MAX_BYTES = 1_000_000;
const DEV_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".jsx"]);
const BROWSER_SCRIPT_EXTENSIONS = new Set([".js", ".mjs"]);
const ACTIVE_DOCUMENT_EXTENSIONS = new Set([".html", ".htm", ".xhtml", ".svg"]);
const ACTIVE_EMBEDDED_DOCUMENT_ELEMENTS = new Set(["embed", "frame", "iframe", "object"]);
const SVG_HREF_RESOURCE_ELEMENTS = new Set(["feimage", "image", "mpath", "use"]);
const SVG_ARBITRARY_ATTRIBUTE_MUTATION_ELEMENTS = new Set(["animate", "set"]);
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const JAVASCRIPT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);
const EXECUTABLE_URL_ATTRIBUTES = new Set([
  "action",
  "data",
  "formaction",
  "href",
  "src",
  "xlink:href",
]);
type DocumentNode = DefaultTreeAdapterMap["document"];
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export interface InspectedHtmlArtifact {
  readonly result: ProjectInspectHtmlArtifactResult;
  readonly absolutePath: string | null;
  readonly baseDirectory: string | null;
  readonly siteRoot: string | null;
  readonly allowedResourcePaths: readonly string[];
  readonly watchedPaths: readonly string[];
  readonly watchDiscoveryLimited: boolean;
  readonly allowedExternalUrls: readonly string[];
  readonly fileFingerprints: ReadonlyMap<string, HtmlArtifactFileFingerprint>;
  readonly classifiedDocumentDigests: ReadonlyMap<string, string>;
}

export interface HtmlArtifactFileFingerprint {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export class HtmlArtifactChangedDuringPreparationError extends Error {
  constructor() {
    super("The HTML artifact changed while its preview was being prepared.");
    this.name = "HtmlArtifactChangedDuringPreparationError";
  }
}

export function htmlArtifactFileFingerprint(
  stat: Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">,
): HtmlArtifactFileFingerprint {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

export function htmlArtifactFileFingerprintsEqual(
  left: HtmlArtifactFileFingerprint,
  right: HtmlArtifactFileFingerprint,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

interface InspectedFileSnapshot {
  readonly fingerprint: HtmlArtifactFileFingerprint;
  readonly contents?: string;
  readonly contentDigest?: string;
}

export type HtmlArtifactReadChunk = (
  handle: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number }>;

export interface HtmlArtifactInspectionOptions {
  readonly readChunk?: HtmlArtifactReadChunk;
}

export function htmlArtifactContentDigest(contents: Uint8Array): string {
  return crypto.createHash("sha256").update(contents).digest("base64url");
}

export async function readExactPositionedBytes(
  handle: FileHandle,
  requestedBytes: number,
  readChunk: HtmlArtifactReadChunk = (source, buffer, offset, length, position) =>
    source.read(buffer, offset, length, position),
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(requestedBytes);
  let totalBytesRead = 0;
  while (totalBytesRead < requestedBytes) {
    const remainingBytes = requestedBytes - totalBytesRead;
    const { bytesRead } = await readChunk(
      handle,
      buffer,
      totalBytesRead,
      remainingBytes,
      totalBytesRead,
    );
    if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > remainingBytes) {
      throw new HtmlArtifactChangedDuringPreparationError();
    }
    totalBytesRead += bytesRead;
  }
  return buffer;
}

async function inspectFileSnapshot(
  filePath: string,
  readMaxBytes?: number,
  options: HtmlArtifactInspectionOptions = {},
): Promise<InspectedFileSnapshot | null> {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) return null;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return null;
    let contents: string | undefined;
    let contentDigest: string | undefined;
    if (readMaxBytes !== undefined) {
      const requestedBytes = Number(
        before.size < BigInt(readMaxBytes) ? before.size : BigInt(readMaxBytes),
      );
      const buffer = await readExactPositionedBytes(handle, requestedBytes, options.readChunk);
      contents = buffer.toString("utf8");
      contentDigest = htmlArtifactContentDigest(buffer);
    }
    const after = await handle.stat({ bigint: true });
    const beforeFingerprint = htmlArtifactFileFingerprint(before);
    if (!htmlArtifactFileFingerprintsEqual(beforeFingerprint, htmlArtifactFileFingerprint(after))) {
      throw new HtmlArtifactChangedDuringPreparationError();
    }
    const canonicalAfterRead = await fs.realpath(filePath).catch(() => null);
    if (canonicalAfterRead !== filePath) {
      throw new HtmlArtifactChangedDuringPreparationError();
    }
    return {
      fingerprint: beforeFingerprint,
      ...(contents !== undefined ? { contents } : {}),
      ...(contentDigest !== undefined ? { contentDigest } : {}),
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = path.normalize(candidate);
  const normalizedRoot = path.normalize(root);
  if (normalizedCandidate === normalizedRoot) return true;
  const rootPrefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`;
  return normalizedCandidate.startsWith(rootPrefix);
}

function isElement(node: Node): node is Element {
  return "tagName" in node && typeof node.tagName === "string";
}

function attributeOf(element: Element, name: string): string | null {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name)?.value ?? null;
}

function textContentOf(node: Node): string {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  return "childNodes" in node ? node.childNodes.map((child) => textContentOf(child)).join("") : "";
}

function visit(node: Node, visitor: (element: Element) => void): void {
  if (isElement(node)) {
    visitor(node);
  }
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      visit(child, visitor);
    }
  }
}

function isExternalResource(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("//") ||
    (/^[a-z][a-z\d+.-]*:/i.test(trimmed) &&
      !trimmed.startsWith("data:") &&
      !trimmed.startsWith("blob:"))
  );
}

function resolveLocalResourcePath(value: string, baseDirectory: string): string | null {
  const withoutQuery = value.trim().split(/[?#]/, 1)[0] ?? "";
  if (
    withoutQuery.length === 0 ||
    withoutQuery.startsWith("#") ||
    withoutQuery.startsWith("data:") ||
    withoutQuery.startsWith("blob:") ||
    isExternalResource(withoutQuery)
  ) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return null;
  }
  return path.resolve(baseDirectory, decoded.replace(/^\/+/, ""));
}

async function nearestRunTarget(
  entryPath: string,
  workspaceRoot: string,
): Promise<ProjectHtmlArtifactRunTarget | undefined> {
  let directory = path.dirname(entryPath);
  while (isPathInside(directory, workspaceRoot)) {
    const packageJsonPath = path.join(directory, "package.json");
    const stat = await fs.stat(packageJsonPath).catch(() => null);
    if (stat?.isFile() && stat.size <= PACKAGE_JSON_MAX_BYTES) {
      const parsed = await fs
        .readFile(packageJsonPath, "utf8")
        .then((contents) => JSON.parse(contents) as unknown)
        .catch(() => null);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const scripts = (parsed as { scripts?: unknown }).scripts;
        if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
          const scriptRecord = scripts as Record<string, unknown>;
          const scriptName = ["dev", "start"].find(
            (name) =>
              typeof scriptRecord[name] === "string" && scriptRecord[name].trim().length > 0,
          );
          if (scriptName) {
            const manager = await detectProjectPackageManager(directory);
            return {
              cwd: directory,
              command: commandForProjectPackageScript(manager, scriptName),
              scriptName,
            };
          }
        }
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function unsupported(reason: string): InspectedHtmlArtifact {
  return {
    result: { mode: "unsupported", reason, warnings: [] },
    absolutePath: null,
    baseDirectory: null,
    siteRoot: null,
    allowedResourcePaths: [],
    watchedPaths: [],
    watchDiscoveryLimited: false,
    allowedExternalUrls: [],
    fileFingerprints: new Map(),
    classifiedDocumentDigests: new Map(),
  };
}

const CSS_URL_PATTERN = /url\(\s*(?:(["'])(.*?)\1|([^"')]*?))\s*\)/gi;
const CSS_IMPORT_STRING_PATTERN = /@import\s+(["'])(.*?)\1/gi;
const JAVASCRIPT_RESOURCE_PATTERN =
  /(?:\bfetch|new\s+(?:Shared)?Worker|navigator\.serviceWorker\.register|importScripts|new\s+URL)\s*\(\s*(["'])([^"']+)\1/g;
const JAVASCRIPT_NAVIGATION_PATTERN =
  /(?:(?:window\.)?open|location\.(?:assign|replace))\s*\(\s*(["'])([^"']+)\1|(?:window\.)?location(?:\.href)?\s*=\s*(["'])([^"']+)\3/g;
const JAVASCRIPT_ATTRIBUTE_RESOURCE_PATTERN =
  /(?:\.\s*(?:src|href|action|poster)\s*=|\.setAttribute\s*\(\s*["'](?:src|href|action|poster)["']\s*,)\s*(["'])([^"']+)\1/g;

function cssResourceReferences(source: string): readonly string[] {
  return [
    ...[...source.matchAll(CSS_URL_PATTERN)].flatMap((match) => {
      const resource = (match[2] ?? match[3])?.trim();
      return resource ? [resource] : [];
    }),
    ...[...source.matchAll(CSS_IMPORT_STRING_PATTERN)].flatMap((match) => {
      const resource = match[2]?.trim();
      return resource ? [resource] : [];
    }),
  ];
}

function javascriptResourceReferences(source: string): readonly string[] {
  return [
    ...[...source.matchAll(JAVASCRIPT_RESOURCE_PATTERN)].flatMap((match) =>
      match[2] ? [match[2]] : [],
    ),
    ...[...source.matchAll(JAVASCRIPT_NAVIGATION_PATTERN)].flatMap((match) => {
      const resource = match[2] ?? match[4];
      return resource ? [resource] : [];
    }),
    ...[...source.matchAll(JAVASCRIPT_ATTRIBUTE_RESOURCE_PATTERN)].flatMap((match) =>
      match[2] ? [match[2]] : [],
    ),
  ];
}

function normalizedExternalResourceUrl(value: string, baseHref?: string | null): string | null {
  try {
    const base = baseHref
      ? new URL(baseHref, "http://preview.invalid/")
      : new URL("http://preview.invalid/");
    const resolved = new URL(value, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    if (resolved.hostname === "preview.invalid") return null;
    resolved.hash = "";
    return resolved.toString();
  } catch {
    return null;
  }
}

function scriptElementIsExecutable(element: Element): boolean {
  const rawType = attributeOf(element, "type")?.trim().toLowerCase();
  if (!rawType || rawType === "module") return true;
  const typeEssence = rawType.split(";", 1)[0]?.trim() ?? "";
  return JAVASCRIPT_MIME_TYPES.has(typeEssence);
}

function scriptSourcePath(element: Element): string | null {
  const sourcePath = attributeOf(element, "src");
  if (sourcePath !== null || element.namespaceURI !== SVG_NAMESPACE) return sourcePath;
  return attributeOf(element, "href") ?? attributeOf(element, "xlink:href");
}

function elementCanMutateSvgAtRuntime(element: Element): boolean {
  return (
    element.namespaceURI === SVG_NAMESPACE &&
    SVG_ARBITRARY_ATTRIBUTE_MUTATION_ELEMENTS.has(element.tagName.toLowerCase())
  );
}

function resourceReferencesForElement(element: Element): readonly string[] {
  const tagName = element.tagName.toLowerCase();
  const resources: string[] = [];
  const add = (attributeName: string) => {
    const value = attributeOf(element, attributeName);
    if (value) resources.push(value);
  };

  if (tagName === "script") {
    if (scriptElementIsExecutable(element)) {
      const sourcePath = scriptSourcePath(element);
      if (sourcePath) resources.push(sourcePath);
    }
  } else if (
    tagName === "link" ||
    tagName === "a" ||
    tagName === "area" ||
    SVG_HREF_RESOURCE_ELEMENTS.has(tagName)
  ) {
    add("href");
    add("xlink:href");
  } else if (tagName === "form") add("action");
  else if (tagName === "object") add("data");
  else add("src");
  if (tagName === "video") add("poster");

  const inlineStyle = attributeOf(element, "style");
  if (inlineStyle) resources.push(...cssResourceReferences(inlineStyle));
  if (tagName === "style") resources.push(...cssResourceReferences(textContentOf(element)));

  const srcset = attributeOf(element, "srcset");
  if (srcset) {
    for (const candidate of srcset.split(",")) {
      const resource = candidate.trim().split(/\s+/, 1)[0];
      if (resource) resources.push(resource);
    }
  }
  return resources;
}

function htmlResourceReferences(source: string): {
  readonly baseHref: string | null;
  readonly resources: readonly string[];
} {
  const document = parse(source) as DocumentNode;
  const resources: string[] = [];
  let baseHref: string | null = null;
  visit(document, (element) => {
    if (element.tagName.toLowerCase() === "base" && baseHref === null) {
      baseHref = attributeOf(element, "href");
      return;
    }
    resources.push(...resourceReferencesForElement(element));
  });
  return { baseHref, resources };
}

function isExecutableUrlAttribute(name: string, value: string): boolean {
  if (!EXECUTABLE_URL_ATTRIBUTES.has(name.toLowerCase())) return false;
  try {
    return new URL(value, "http://preview.invalid/").protocol === "javascript:";
  } catch {
    return true;
  }
}

function markupHasExecutableContent(source: string, srcdocDepth = 0): boolean {
  const document = parse(source) as DocumentNode;
  let executable = false;
  let baseHref: string | null = null;
  visit(document, (element) => {
    if (baseHref === null && element.tagName.toLowerCase() === "base") {
      baseHref = attributeOf(element, "href");
    }
  });
  visit(document, (element) => {
    if (executable) return;
    const tagName = element.tagName.toLowerCase();
    if (
      tagName === "script" &&
      scriptElementIsExecutable(element) &&
      (scriptSourcePath(element) !== null || textContentOf(element).trim().length > 0)
    ) {
      executable = true;
      return;
    }
    if (elementCanMutateSvgAtRuntime(element)) {
      executable = true;
      return;
    }
    if (ACTIVE_EMBEDDED_DOCUMENT_ELEMENTS.has(tagName)) {
      const documentUrl = attributeOf(element, tagName === "object" ? "data" : "src");
      if (documentUrl && normalizedExternalResourceUrl(documentUrl, baseHref)) {
        // Remote framed documents are active content even when the local entry
        // contains no script of its own. Their response can execute arbitrary
        // JavaScript and must inherit the sealed interactive policy.
        executable = true;
        return;
      }
    }
    if (
      element.attrs.some(
        (attribute) =>
          (attribute.name.toLowerCase().startsWith("on") && attribute.value.trim().length > 0) ||
          isExecutableUrlAttribute(attribute.name, attribute.value),
      )
    ) {
      executable = true;
      return;
    }
    const srcdoc = attributeOf(element, "srcdoc");
    if (srcdoc && (srcdocDepth >= 8 || markupHasExecutableContent(srcdoc, srcdocDepth + 1))) {
      executable = true;
    }
  });
  return executable;
}

function resolveHtmlDocumentResourcePath(input: {
  value: string;
  documentPath: string;
  siteRoot: string;
  baseHref: string | null;
}): string | null {
  let referenceDirectory = path.dirname(input.documentPath);
  if (input.baseHref) {
    if (isExternalResource(input.baseHref)) return null;
    const basePath = resolveLocalResourcePath(
      input.baseHref,
      input.baseHref.trim().startsWith("/") ? input.siteRoot : referenceDirectory,
    );
    if (!basePath) return null;
    const baseWithoutQuery = input.baseHref.trim().split(/[?#]/, 1)[0] ?? "";
    referenceDirectory = baseWithoutQuery.endsWith("/") ? basePath : path.dirname(basePath);
  }
  return resolveLocalResourcePath(
    input.value,
    input.value.trim().startsWith("/") ? input.siteRoot : referenceDirectory,
  );
}

async function collectAllowedResourcePaths(
  resources: readonly string[],
  entryPath: string,
  entryBaseHref: string | null,
  resourceBoundary: string,
  options: HtmlArtifactInspectionOptions,
): Promise<{
  readonly paths: readonly string[];
  readonly fileFingerprints: ReadonlyMap<string, HtmlArtifactFileFingerprint>;
  readonly classifiedDocumentDigests: ReadonlyMap<string, string>;
  readonly watchedPaths: readonly string[];
  readonly watchDiscoveryLimited: boolean;
  readonly externalUrls: readonly string[];
  readonly hasExecutableDocument: boolean;
  readonly hasTruncatedActiveDocument: boolean;
  readonly hasTruncatedDependency: boolean;
}> {
  const pending = resources
    .slice(0, RESOURCE_GRAPH_MAX_FILES)
    .map((resource) =>
      resolveHtmlDocumentResourcePath({
        value: resource,
        documentPath: entryPath,
        siteRoot: resourceBoundary,
        baseHref: entryBaseHref,
      }),
    )
    .filter((resource): resource is string => resource !== null);
  const allowed = new Set<string>();
  const fileFingerprints = new Map<string, HtmlArtifactFileFingerprint>();
  const classifiedDocumentDigests = new Map<string, string>();
  const watchedPaths = new Set<string>();
  const externalUrls = new Set<string>();
  const canonicalResourceBoundary = await fs.realpath(resourceBoundary).catch(() => null);
  let hasExecutableDocument = false;
  let hasTruncatedActiveDocument = false;
  let hasTruncatedDependency = false;
  let watchDiscoveryLimited = resources.length > RESOURCE_GRAPH_MAX_FILES;
  const inspectedCandidates = new Set<string>();
  const queuedCandidates = new Set(pending);
  let missingAncestorProbes = 0;
  const queueCandidate = (candidate: string | null) => {
    if (!candidate || inspectedCandidates.has(candidate) || queuedCandidates.has(candidate)) return;
    if (inspectedCandidates.size + queuedCandidates.size >= RESOURCE_GRAPH_MAX_FILES) {
      watchDiscoveryLimited = true;
      return;
    }
    queuedCandidates.add(candidate);
    pending.push(candidate);
  };
  const addExternalUrl = (url: string) => {
    if (externalUrls.size < RESOURCE_GRAPH_MAX_FILES) externalUrls.add(url);
  };
  const missingPathWatchCandidate = async (candidate: string): Promise<string | null> => {
    if (!canonicalResourceBoundary) return null;
    let firstMissingPath = candidate;
    while (true) {
      if (missingAncestorProbes >= RESOURCE_GRAPH_MAX_FILES) {
        watchDiscoveryLimited = true;
        return null;
      }
      missingAncestorProbes += 1;
      const parent = path.dirname(firstMissingPath);
      if (parent === firstMissingPath) return null;
      const canonicalParent = await fs.realpath(parent).catch(() => null);
      if (canonicalParent) {
        return isPathInside(canonicalParent, canonicalResourceBoundary)
          ? path.join(canonicalParent, path.basename(firstMissingPath))
          : null;
      }
      firstMissingPath = parent;
    }
  };

  while (pending.length > 0 && inspectedCandidates.size < RESOURCE_GRAPH_MAX_FILES) {
    const candidate = pending.shift();
    if (!candidate) continue;
    queuedCandidates.delete(candidate);
    if (inspectedCandidates.has(candidate)) continue;
    inspectedCandidates.add(candidate);
    const canonical = await fs.realpath(candidate).catch(() => null);
    if (!canonical) {
      // Watch the first missing component below the nearest canonical existing
      // ancestor. This sees both a missing file in an existing directory and a
      // later-created directory tree without trusting a lexical path through a
      // symlink. The next inspection replaces this trigger with a more precise one.
      const watchCandidate = await missingPathWatchCandidate(candidate);
      if (watchCandidate) {
        if (watchedPaths.size < RESOURCE_GRAPH_MAX_FILES) watchedPaths.add(watchCandidate);
        else watchDiscoveryLimited = true;
      }
      continue;
    }
    if (!isPathInside(canonical, resourceBoundary) || allowed.has(canonical)) continue;
    const extension = path.extname(canonical).toLowerCase();
    const isActiveDocument = ACTIVE_DOCUMENT_EXTENSIONS.has(extension);
    const isInspectableDependency =
      extension === ".css" || extension === ".js" || extension === ".mjs";
    const snapshot = await inspectFileSnapshot(
      canonical,
      isActiveDocument || isInspectableDependency ? RESOURCE_GRAPH_PARSE_MAX_BYTES : undefined,
      options,
    );
    if (!snapshot) continue;
    allowed.add(canonical);
    fileFingerprints.set(canonical, snapshot.fingerprint);
    if (isActiveDocument && snapshot.contentDigest) {
      classifiedDocumentDigests.set(canonical, snapshot.contentDigest);
    }
    if (watchedPaths.size < RESOURCE_GRAPH_MAX_FILES) watchedPaths.add(canonical);
    else watchDiscoveryLimited = true;

    if (!isActiveDocument && !isInspectableDependency) {
      continue;
    }
    if (!isActiveDocument && snapshot.fingerprint.size > BigInt(RESOURCE_GRAPH_PARSE_MAX_BYTES)) {
      hasTruncatedDependency = true;
    }
    const contents = snapshot.contents ?? "";
    if (isActiveDocument) {
      if (snapshot.fingerprint.size > BigInt(RESOURCE_GRAPH_PARSE_MAX_BYTES)) {
        // The complete served document was not classified, so it must never
        // inherit static-mode network access even when its inspected prefix is inert.
        hasExecutableDocument = true;
        hasTruncatedActiveDocument = true;
      }
      hasExecutableDocument ||= markupHasExecutableContent(contents);
      const linkedDocument = htmlResourceReferences(contents);
      for (const dependency of linkedDocument.resources) {
        const externalUrl = normalizedExternalResourceUrl(dependency, linkedDocument.baseHref);
        if (externalUrl) {
          addExternalUrl(externalUrl);
          continue;
        }
        const resolved = resolveHtmlDocumentResourcePath({
          value: dependency,
          documentPath: canonical,
          siteRoot: resourceBoundary,
          baseHref: linkedDocument.baseHref,
        });
        queueCandidate(resolved);
      }
      continue;
    }
    const dependencyDirectory = path.dirname(canonical);
    if (extension === ".css") {
      for (const dependency of cssResourceReferences(contents)) {
        const externalUrl = normalizedExternalResourceUrl(dependency);
        if (externalUrl) {
          addExternalUrl(externalUrl);
          continue;
        }
        const resolved = dependency
          ? resolveLocalResourcePath(
              dependency,
              dependency.startsWith("/") ? resourceBoundary : dependencyDirectory,
            )
          : null;
        queueCandidate(resolved);
      }
      continue;
    }

    for (const dependency of javascriptResourceReferences(contents)) {
      const externalUrl = normalizedExternalResourceUrl(dependency);
      if (externalUrl) {
        addExternalUrl(externalUrl);
        continue;
      }
      const resolved = resolveLocalResourcePath(
        dependency,
        dependency.startsWith("/") ? resourceBoundary : dependencyDirectory,
      );
      queueCandidate(resolved);
    }

    await initializeModuleLexer;
    try {
      const [imports] = parseModuleImports(contents);
      for (const moduleImport of imports) {
        const dependency = moduleImport.n;
        if (!dependency || (!dependency.startsWith(".") && !dependency.startsWith("/"))) {
          const externalUrl = dependency ? normalizedExternalResourceUrl(dependency) : null;
          if (externalUrl) addExternalUrl(externalUrl);
          continue;
        }
        const resolved = dependency
          ? resolveLocalResourcePath(
              dependency,
              dependency.startsWith("/") ? resourceBoundary : dependencyDirectory,
            )
          : null;
        queueCandidate(resolved);
      }
    } catch {
      // A bounded prefix can end in the middle of a token. Literal-reference
      // discovery above still preserves dependencies found before the cutoff.
    }
  }

  return {
    paths: [...allowed],
    fileFingerprints,
    classifiedDocumentDigests,
    watchedPaths: [...watchedPaths],
    watchDiscoveryLimited: watchDiscoveryLimited || pending.length > 0,
    externalUrls: [...externalUrls],
    hasExecutableDocument,
    hasTruncatedActiveDocument,
    hasTruncatedDependency,
  };
}

function commonSiteRoot(
  entryPath: string,
  resourcePaths: readonly string[],
  resourceBoundary: string,
): string {
  let common = path.dirname(entryPath);
  for (const resourcePath of resourcePaths) {
    while (!isPathInside(resourcePath, common) && common !== resourceBoundary) {
      const parent = path.dirname(common);
      if (parent === common || !isPathInside(parent, resourceBoundary)) break;
      common = parent;
    }
  }
  return isPathInside(common, resourceBoundary) ? common : resourceBoundary;
}

export async function inspectHtmlArtifact(
  input: ProjectInspectHtmlArtifactInput,
  options: HtmlArtifactInspectionOptions = {},
): Promise<InspectedHtmlArtifact> {
  const canonicalWorkspaceRoot = await fs.realpath(path.resolve(input.cwd)).catch(() => null);
  if (!canonicalWorkspaceRoot) {
    return unsupported("The workspace is not available.");
  }

  const requestedPath = path.isAbsolute(input.path)
    ? path.resolve(input.path)
    : path.resolve(canonicalWorkspaceRoot, input.path);
  const absolutePath = await fs.realpath(requestedPath).catch(() => null);
  if (!absolutePath) {
    return unsupported("The HTML file no longer exists.");
  }
  // Relative references remain workspace-contained. Absolute file links are
  // intentionally allowed: chat transcripts and tool output frequently point
  // at deliverables in Downloads, temporary workspaces, or another checkout.
  if (!path.isAbsolute(input.path) && !isPathInside(absolutePath, canonicalWorkspaceRoot)) {
    return unsupported("The relative HTML path resolves outside the active workspace.");
  }
  if (!isSupportedLocalHtmlPath(absolutePath)) {
    return unsupported("Only HTML files can be inspected for browser preview.");
  }

  const entrySnapshot = await inspectFileSnapshot(absolutePath, HTML_INSPECTION_MAX_BYTES, options);
  if (!entrySnapshot) {
    return unsupported("The HTML artifact is not a file.");
  }
  const source = entrySnapshot.contents ?? "";
  const document = parse(source) as DocumentNode;
  const baseDirectory = path.dirname(absolutePath);
  // Opening one HTML document authorizes only its containing site directory.
  // Parent traversal requires a separate, explicit site-root choice; markup is
  // never allowed to nominate arbitrary files elsewhere in the workspace.
  const resourceBoundary = baseDirectory;
  const warnings: ProjectHtmlArtifactWarning[] = [];
  if (entrySnapshot.fingerprint.size > BigInt(HTML_INSPECTION_MAX_BYTES)) {
    warnings.push({
      code: "inspection-truncated",
      message:
        "Only the beginning of this large HTML file was inspected; the full file will still open.",
    });
  }
  const localResources: Array<{ value: string; executable: boolean }> = [];
  const externalResources = new Set<string>();
  const addExternalResource = (url: string) => {
    if (externalResources.size < RESOURCE_GRAPH_MAX_FILES) externalResources.add(url);
  };
  let title: string | undefined;
  let hasInlineScript = false;
  let hasBrowserScript = false;
  let hasDevSource = /(?:\/@vite\/client|react-refresh|\.tsx?(?:[?"'])|\.jsx(?:[?"']))/i.test(
    source,
  );
  let hasUnsupportedExecutable = false;
  const documentBaseHref = htmlResourceReferences(source).baseHref;
  const inlineModuleSources: string[] = [];

  const addWarning = (warning: ProjectHtmlArtifactWarning) => {
    if (
      warnings.length < MAX_WARNINGS &&
      !warnings.some((entry) => entry.message === warning.message)
    ) {
      warnings.push(warning);
    }
  };

  visit(document, (element) => {
    const tagName = element.tagName.toLowerCase();
    if (
      elementCanMutateSvgAtRuntime(element) ||
      element.attrs.some(
        (attribute) =>
          (attribute.name.toLowerCase().startsWith("on") && attribute.value.trim().length > 0) ||
          isExecutableUrlAttribute(attribute.name, attribute.value),
      )
    ) {
      hasInlineScript = true;
    }
    const srcdoc = attributeOf(element, "srcdoc");
    if (srcdoc && markupHasExecutableContent(srcdoc)) {
      hasInlineScript = true;
    }
    if (ACTIVE_EMBEDDED_DOCUMENT_ELEMENTS.has(tagName)) {
      const documentUrl = attributeOf(element, tagName === "object" ? "data" : "src");
      if (documentUrl && normalizedExternalResourceUrl(documentUrl, documentBaseHref)) {
        hasInlineScript = true;
      }
    }
    if (tagName === "base") {
      return;
    }
    if (tagName === "title" && !title) {
      const candidate = textContentOf(element).replace(/\s+/g, " ").trim();
      if (candidate) title = candidate.slice(0, 500);
      return;
    }

    if (tagName === "script") {
      if (!scriptElementIsExecutable(element)) return;
      const sourcePath = scriptSourcePath(element);
      if (!sourcePath) {
        const inlineScript = textContentOf(element);
        hasInlineScript ||= inlineScript.trim().length > 0;
        if (attributeOf(element, "type")?.trim().toLowerCase() === "module") {
          inlineModuleSources.push(inlineScript);
        }
        for (const resource of javascriptResourceReferences(inlineScript)) {
          const externalUrl = normalizedExternalResourceUrl(resource);
          if (externalUrl) {
            addExternalResource(externalUrl);
          } else if (!isExternalResource(resource)) {
            localResources.push({ value: resource, executable: false });
          }
        }
        return;
      }
      if (isExternalResource(sourcePath)) {
        const externalUrl = normalizedExternalResourceUrl(sourcePath);
        if (externalUrl) addExternalResource(externalUrl);
        hasBrowserScript = true;
        return;
      }
      const extension = lowerCaseExtensionOf(sourcePath.split(/[?#]/, 1)[0] ?? "");
      if (extension && DEV_SOURCE_EXTENSIONS.has(extension)) {
        hasDevSource = true;
      } else if (extension && BROWSER_SCRIPT_EXTENSIONS.has(extension)) {
        hasBrowserScript = true;
      } else {
        hasUnsupportedExecutable = true;
        addWarning({
          code: "unsupported-local-resource",
          message: `Unsupported script type: ${sourcePath.slice(0, 300)}`,
        });
      }
      localResources.push({ value: sourcePath, executable: true });
      return;
    }

    for (const resource of resourceReferencesForElement(element)) {
      const externalUrl = normalizedExternalResourceUrl(resource, documentBaseHref);
      if (externalUrl) {
        addExternalResource(externalUrl);
      } else if (!isExternalResource(resource)) {
        localResources.push({ value: resource, executable: false });
      }
    }
  });

  if (inlineModuleSources.length > 0) {
    await initializeModuleLexer;
    for (const inlineModule of inlineModuleSources) {
      const [imports] = parseModuleImports(inlineModule);
      for (const moduleImport of imports) {
        const dependency = moduleImport.n;
        if (dependency && (dependency.startsWith(".") || dependency.startsWith("/"))) {
          localResources.push({ value: dependency, executable: true });
        }
      }
    }
  }

  for (const resource of localResources) {
    const resolved = resolveHtmlDocumentResourcePath({
      value: resource.value,
      documentPath: absolutePath,
      siteRoot: resourceBoundary,
      baseHref: documentBaseHref,
    });
    if (!resolved) continue;
    const canonical = await fs.realpath(resolved).catch(() => null);
    if (!canonical) {
      addWarning({
        code: "missing-local-resource",
        message: `Local preview resource was not found: ${resource.value.slice(0, 300)}`,
      });
      continue;
    }
    if (!isPathInside(canonical, resourceBoundary)) {
      addWarning({
        code: "local-resource-denied",
        message: `Local preview resource is outside the opened file's authority: ${resource.value.slice(0, 300)}`,
      });
    }
  }

  const collectedResources = await collectAllowedResourcePaths(
    localResources.map((resource) => resource.value),
    absolutePath,
    documentBaseHref,
    resourceBoundary,
    options,
  );
  const allowedResourcePaths = collectedResources.paths;
  for (const externalUrl of collectedResources.externalUrls) addExternalResource(externalUrl);
  if (collectedResources.hasTruncatedActiveDocument) {
    addWarning({
      code: "inspection-truncated",
      message:
        "Only the beginning of a linked active document was inspected; it will open in interactive mode and its discovered assets remain available.",
    });
  }
  if (collectedResources.hasTruncatedDependency) {
    addWarning({
      code: "inspection-truncated",
      message:
        "Only the beginning of a large linked stylesheet or script was inspected; references after the inspected prefix may be unavailable.",
    });
  }

  const runTarget =
    hasDevSource && isPathInside(absolutePath, canonicalWorkspaceRoot)
      ? await nearestRunTarget(absolutePath, canonicalWorkspaceRoot)
      : undefined;
  const mode =
    hasDevSource && runTarget
      ? "dev-server-entrypoint"
      : hasDevSource ||
          hasInlineScript ||
          hasBrowserScript ||
          hasUnsupportedExecutable ||
          collectedResources.hasExecutableDocument ||
          entrySnapshot.fingerprint.size > BigInt(HTML_INSPECTION_MAX_BYTES)
        ? "interactive-bundle"
        : "static-document";
  const reason =
    mode === "dev-server-entrypoint"
      ? "This HTML file references source modules and must run through its development server."
      : undefined;

  if (mode === "interactive-bundle" && externalResources.size > 0) {
    addWarning({
      code: "external-resource-blocked",
      message:
        "External network resources are blocked for interactive local HTML; bundle them into the same site directory instead.",
    });
  }

  return {
    result: {
      mode,
      ...(title ? { title } : {}),
      ...(reason ? { reason } : {}),
      warnings,
      ...(runTarget ? { runTarget } : {}),
    },
    absolutePath,
    baseDirectory,
    siteRoot: commonSiteRoot(absolutePath, allowedResourcePaths, resourceBoundary),
    allowedResourcePaths,
    watchedPaths: [absolutePath, ...collectedResources.watchedPaths],
    watchDiscoveryLimited: collectedResources.watchDiscoveryLimited,
    allowedExternalUrls: [...externalResources],
    fileFingerprints: new Map([
      ...collectedResources.fileFingerprints,
      [absolutePath, entrySnapshot.fingerprint],
    ]),
    classifiedDocumentDigests: new Map([
      ...collectedResources.classifiedDocumentDigests,
      [absolutePath, entrySnapshot.contentDigest!],
    ]),
  };
}
