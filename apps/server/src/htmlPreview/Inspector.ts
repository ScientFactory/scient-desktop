// FILE: Inspector.ts
// Purpose: Classify local HTML artifacts before any executable preview capability is issued.
// Layer: Server HTML-preview domain logic

import fs from "node:fs/promises";
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
type DocumentNode = DefaultTreeAdapterMap["document"];
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export interface InspectedHtmlArtifact {
  readonly result: ProjectInspectHtmlArtifactResult;
  readonly absolutePath: string | null;
  readonly baseDirectory: string | null;
  readonly siteRoot: string | null;
  readonly allowedResourcePaths: readonly string[];
  readonly allowedExternalUrls: readonly string[];
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
    allowedExternalUrls: [],
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

function resourceReferencesForElement(element: Element): readonly string[] {
  const tagName = element.tagName.toLowerCase();
  const resources: string[] = [];
  const add = (attributeName: string) => {
    const value = attributeOf(element, attributeName);
    if (value) resources.push(value);
  };

  if (tagName === "link" || tagName === "a" || tagName === "area") add("href");
  else if (tagName === "form") add("action");
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
): Promise<{ readonly paths: readonly string[]; readonly externalUrls: readonly string[] }> {
  const pending = resources
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
  const externalUrls = new Set<string>();
  const addExternalUrl = (url: string) => {
    if (externalUrls.size < RESOURCE_GRAPH_MAX_FILES) externalUrls.add(url);
  };

  while (pending.length > 0 && allowed.size < RESOURCE_GRAPH_MAX_FILES) {
    const candidate = pending.shift();
    if (!candidate) continue;
    const canonical = await fs.realpath(candidate).catch(() => null);
    if (!canonical || !isPathInside(canonical, resourceBoundary) || allowed.has(canonical))
      continue;
    const stat = await fs.stat(canonical).catch(() => null);
    if (!stat?.isFile()) continue;
    allowed.add(canonical);

    const extension = path.extname(canonical).toLowerCase();
    if (
      stat.size > RESOURCE_GRAPH_PARSE_MAX_BYTES ||
      (extension !== ".css" &&
        extension !== ".js" &&
        extension !== ".mjs" &&
        extension !== ".html" &&
        extension !== ".htm")
    ) {
      continue;
    }
    const contents = await fs.readFile(canonical, "utf8");
    if (extension === ".html" || extension === ".htm") {
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
        if (resolved) pending.push(resolved);
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
        if (resolved) pending.push(resolved);
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
      if (resolved) pending.push(resolved);
    }

    await initializeModuleLexer;
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
      if (resolved) pending.push(resolved);
    }
  }

  return { paths: [...allowed], externalUrls: [...externalUrls] };
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

async function readInspectionPrefix(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(HTML_INSPECTION_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function inspectHtmlArtifact(
  input: ProjectInspectHtmlArtifactInput,
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

  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) {
    return unsupported("The HTML artifact is not a file.");
  }
  const source = await readInspectionPrefix(absolutePath);
  const document = parse(source) as DocumentNode;
  const baseDirectory = path.dirname(absolutePath);
  // Opening one HTML document authorizes only its containing site directory.
  // Parent traversal requires a separate, explicit site-root choice; markup is
  // never allowed to nominate arbitrary files elsewhere in the workspace.
  const resourceBoundary = baseDirectory;
  const warnings: ProjectHtmlArtifactWarning[] = [];
  if (stat.size > HTML_INSPECTION_MAX_BYTES) {
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
      element.attrs.some(
        (attribute) =>
          (attribute.name.toLowerCase().startsWith("on") && attribute.value.trim().length > 0) ||
          (/^(?:href|src|action)$/i.test(attribute.name) &&
            attribute.value.trim().toLowerCase().startsWith("javascript:")),
      )
    ) {
      hasInlineScript = true;
    }
    const srcdoc = attributeOf(element, "srcdoc");
    if (srcdoc && /<script\b|\bon\w+\s*=|javascript:/i.test(srcdoc)) {
      hasInlineScript = true;
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
      const sourcePath = attributeOf(element, "src");
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

  const runTarget =
    hasDevSource && isPathInside(absolutePath, canonicalWorkspaceRoot)
      ? await nearestRunTarget(absolutePath, canonicalWorkspaceRoot)
      : undefined;
  const mode =
    hasDevSource && runTarget
      ? "dev-server-entrypoint"
      : hasDevSource || hasInlineScript || hasBrowserScript || hasUnsupportedExecutable
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

  const collectedResources = await collectAllowedResourcePaths(
    localResources.map((resource) => resource.value),
    absolutePath,
    documentBaseHref,
    resourceBoundary,
  );
  const allowedResourcePaths = collectedResources.paths;
  for (const externalUrl of collectedResources.externalUrls) addExternalResource(externalUrl);

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
    allowedExternalUrls: [...externalResources],
  };
}
