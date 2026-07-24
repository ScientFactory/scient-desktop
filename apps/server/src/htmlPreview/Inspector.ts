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

async function resourceExists(value: string, baseDirectory: string): Promise<boolean> {
  const resolved = resolveLocalResourcePath(value, baseDirectory);
  if (!resolved) return true;
  const stat = await fs.stat(resolved).catch(() => null);
  return Boolean(stat?.isFile());
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
  };
}

const CSS_RESOURCE_PATTERN = /(?:url\(\s*|@import\s+(?:url\(\s*)?)["']?([^"')\s]+)["']?\s*\)?/gi;

async function collectAllowedResourcePaths(
  resources: readonly string[],
  baseDirectory: string,
  resourceBoundary: string,
): Promise<readonly string[]> {
  const pending = resources
    .map((resource) => resolveLocalResourcePath(resource, baseDirectory))
    .filter((resource): resource is string => resource !== null);
  const allowed = new Set<string>();

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
      (extension !== ".css" && extension !== ".js" && extension !== ".mjs")
    ) {
      continue;
    }
    const contents = await fs.readFile(canonical, "utf8");
    const dependencyDirectory = path.dirname(canonical);
    if (extension === ".css") {
      for (const match of contents.matchAll(CSS_RESOURCE_PATTERN)) {
        const dependency = match[1];
        const resolved = dependency
          ? resolveLocalResourcePath(
              dependency,
              dependency.startsWith("/") ? baseDirectory : dependencyDirectory,
            )
          : null;
        if (resolved) pending.push(resolved);
      }
      continue;
    }

    await initializeModuleLexer;
    const [imports] = parseModuleImports(contents);
    for (const moduleImport of imports) {
      const dependency = moduleImport.n;
      if (!dependency || (!dependency.startsWith(".") && !dependency.startsWith("/"))) {
        continue;
      }
      const resolved = dependency
        ? resolveLocalResourcePath(
            dependency,
            dependency.startsWith("/") ? baseDirectory : dependencyDirectory,
          )
        : null;
      if (resolved) pending.push(resolved);
    }
  }

  return [...allowed];
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
  const warnings: ProjectHtmlArtifactWarning[] = [];
  if (stat.size > HTML_INSPECTION_MAX_BYTES) {
    warnings.push({
      code: "inspection-truncated",
      message:
        "Only the beginning of this large HTML file was inspected; the full file will still open.",
    });
  }
  const localResources: Array<{ value: string; executable: boolean }> = [];
  let title: string | undefined;
  let hasInlineScript = false;
  let hasBrowserScript = false;
  let hasDevSource = /(?:\/@vite\/client|react-refresh|\.tsx?(?:[?"'])|\.jsx(?:[?"']))/i.test(
    source,
  );
  let hasUnsupportedExecutable = false;

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
    if (tagName === "title" && !title) {
      const candidate = textContentOf(element).replace(/\s+/g, " ").trim();
      if (candidate) title = candidate.slice(0, 500);
      return;
    }

    if (tagName === "script") {
      const sourcePath = attributeOf(element, "src");
      if (!sourcePath) {
        hasInlineScript = textContentOf(element).trim().length > 0;
        return;
      }
      if (isExternalResource(sourcePath)) {
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

    const resourceAttribute =
      tagName === "link" ? attributeOf(element, "href") : attributeOf(element, "src");
    if (!resourceAttribute) return;
    if (isExternalResource(resourceAttribute)) {
      return;
    }
    localResources.push({ value: resourceAttribute, executable: false });
  });

  for (const resource of localResources) {
    if (!(await resourceExists(resource.value, baseDirectory))) {
      addWarning({
        code: "missing-local-resource",
        message: `Local preview resource was not found: ${resource.value.slice(0, 300)}`,
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

  // A workspace-relative document stays rooted in its project. An explicitly
  // absolute document may itself be nested below a site root and legitimately
  // reference `../assets/...`; infer that common root from the resources the
  // document actually names instead of assuming its immediate directory.
  const resourceBoundary = isPathInside(absolutePath, canonicalWorkspaceRoot)
    ? canonicalWorkspaceRoot
    : path.parse(absolutePath).root;
  const allowedResourcePaths = await collectAllowedResourcePaths(
    localResources.map((resource) => resource.value),
    baseDirectory,
    resourceBoundary,
  );

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
  };
}
