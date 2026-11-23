// @effect-diagnostics nodeBuiltinImport:off -- revisions are files under Scient's compute state, hashed and moved with Node.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ComputeExecutionResultRecord } from "@scientfactory/compute";
import type {
  ComputeResultCause,
  ComputeResultInput,
  ComputeResultEnvironment,
  ComputeResultParameter,
  ComputeResultSourceKind,
  ComputeResultOutput,
  ComputeResultOutputKind,
  ComputeResultOutputContent,
  ComputeResultReference,
  ComputeResultResolution,
  ComputeResultRevision,
  ComputeResultScript,
  ComputeResultSummary,
  ComputeResultValue,
  ComputeResultsPublicationInput,
} from "@t3tools/contracts";
import { ComputeResultRevision as ComputeResultRevisionSchema } from "@t3tools/contracts";
import {
  readResultValues,
  resultInputCoverageIncomplete,
  resultSourceChanged,
  resultValueAt,
} from "@t3tools/shared/computeResults";
import { isSavedDataView, savedViewReferences } from "@t3tools/shared/savedDataView";
import * as Schema from "effect/Schema";

import { indexNotebook, notebookCellTags, notebookText } from "../notebook/notebookIndex.ts";
import { parseCsv } from "./latexOutputs.ts";
import { isResultAttemptPending, readLastResultAttempt } from "./resultAttempts.ts";

const MAXIMUM_OUTPUT_FILES = 64;
const MAXIMUM_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_VALUES_FILE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_HASHED_INPUT_BYTES = 256 * 1024 * 1024;
/** Revisions per script whose figure bytes stay in the record; metadata and values stay for good. */
const RETAINED_FIGURE_REVISIONS = 20;

const decodeRevision = Schema.decodeUnknownSync(ComputeResultRevisionSchema);

export interface ResultsLayout {
  readonly computeDir: string;
}

const projectFolder = (layout: ResultsLayout, projectId: string) =>
  NodePath.join(layout.computeDir, "results", projectId);
const revisionsFolder = (layout: ResultsLayout, projectId: string) =>
  NodePath.join(projectFolder(layout, projectId), "revisions");
const revisionFolder = (layout: ResultsLayout, projectId: string, revision: string) =>
  NodePath.join(revisionsFolder(layout, projectId), revision);

function revisionOutputPath(
  layout: ResultsLayout,
  projectId: string,
  revision: string,
  output: string,
): string | null {
  const outputs = NodePath.join(revisionFolder(layout, projectId, revision), "outputs");
  const resolved = NodePath.resolve(outputs, ...output.split("/"));
  return resolved.startsWith(`${outputs}${NodePath.sep}`) ? resolved : null;
}

export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path, { signal })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const sha256Text = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

function newRevisionId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = NodeCrypto.randomBytes(12);
  return `r${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

const toPosix = (path: string) => path.split(NodePath.sep).join("/");

/** A project-relative POSIX path, or null outside the project. */
function projectRelative(root: string, path: string): string | null {
  const relative = NodePath.relative(root, path);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  )
    return null;
  return toPosix(relative);
}

function outputKind(name: string): { kind: ComputeResultOutputKind; mediaType: string } {
  switch (NodePath.extname(name).toLowerCase()) {
    case ".json":
      return { kind: "values", mediaType: "application/json" };
    case ".png":
      return { kind: "figure", mediaType: "image/png" };
    case ".jpg":
    case ".jpeg":
      return { kind: "figure", mediaType: "image/jpeg" };
    case ".svg":
      return { kind: "figure", mediaType: "image/svg+xml" };
    case ".pdf":
      return { kind: "figure", mediaType: "application/pdf" };
    case ".csv":
      return { kind: "table", mediaType: "text/csv" };
    case ".tex":
      return { kind: "latex", mediaType: "text/x-tex" };
    default:
      return { kind: "file", mediaType: "application/octet-stream" };
  }
}

async function listFiles(folder: string): Promise<ReadonlyArray<string>> {
  const entries = await NodeFSP.readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => toPosix(NodePath.relative(folder, NodePath.join(entry.parentPath, entry.name))))
    .toSorted();
}

export interface SettledScriptRun {
  readonly projectId: string;
  readonly root: string;
  readonly stagingFolder: string;
  readonly succeeded: boolean;
  readonly kind?: ComputeResultSourceKind;
  readonly parameters?: ReadonlyArray<ComputeResultParameter>;
  readonly declaredInputs?: ReadonlyArray<string>;
  readonly environment?: ComputeResultEnvironment;
  readonly declaredSnapshots?: ReadonlyArray<ComputeResultInput>;
  readonly declaredGlobs?: ReadonlyArray<DirectoryInput>;
  readonly unresolvedViewInputs?: ReadonlyArray<UnresolvedViewInput>;
  readonly scriptPath: string;
  readonly language: string;
  readonly code: string;
  readonly codeSha256?: string;
  readonly publication?: ComputeResultRevision["publication"];
  readonly sessionId: string;
  readonly executionId: string;
  readonly startedAt: string | null;
  readonly finishedAt: string;
  readonly threadId: string | undefined;
  readonly runtime: ComputeResultRevision["runtime"];
  readonly reads: ComputeExecutionResultRecord["reads"];
}

export type PublishOutcome =
  | { readonly _tag: "published"; readonly revision: ComputeResultRevision }
  | { readonly _tag: "failed"; readonly message: string };

type DirectoryInput = NonNullable<ComputeResultRevision["inputs"]["directories"]>[number];

async function projectEntry(root: string, path: string) {
  if (NodePath.resolve(path) !== root && projectRelative(root, path) === null) return null;
  return NodeFSP.realpath(path).catch(() => null);
}

function listingHash(names: string[]): string {
  names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return sha256Text(JSON.stringify(names));
}

const placementDirectories = new Set(["assets", "results", ".scient"]);

export function observedDirectoryInputs(revision: ComputeResultRevision) {
  return (revision.inputs.directories ?? []).filter(
    ({ path }) =>
      (path !== "." || revision.inputs.directoryListingVersion === 3) &&
      !path.split("/").some((part) => placementDirectories.has(part)),
  );
}

async function directoryHash(
  root: string,
  relative: string,
  excludePlacements = true,
): Promise<string | null> {
  const actual = await projectEntry(root, NodePath.join(root, ...relative.split("/")));
  if (actual === null) return null;
  const names: string[] = [];
  try {
    // Python hashes the same sorted UTF-8 names. Stop before loading an unbounded directory.
    for await (const entry of await NodeFSP.opendir(actual)) {
      if (
        entry.name === ".git" ||
        entry.name === "__pycache__" ||
        (excludePlacements && placementDirectories.has(entry.name))
      )
        continue;
      if (names.length >= 512) return "listing-limit";
      names.push(entry.name);
    }
  } catch {
    return null;
  }
  return listingHash(names);
}

async function recordInput(
  root: string,
  read: {
    readonly path: string;
    readonly size: number;
    readonly modifiedAtNs: string;
    readonly changedAtNs?: string | undefined;
  },
): Promise<ComputeResultInput | null> {
  const relative = projectRelative(root, read.path);
  if (relative === null) return null;
  const actual = await projectEntry(root, read.path);
  const status =
    actual === null ? null : await NodeFSP.stat(actual, { bigint: true }).catch(() => null);
  if (actual === null || status === null || !status.isFile())
    return {
      path: relative,
      size: read.size,
      modifiedAtNs: read.modifiedAtNs,
      changedAtNs: "0",
      sha256: null,
      changedDuringRun: true,
    };
  return {
    path: relative,
    size: Number(status.size),
    modifiedAtNs: status.mtimeNs.toString(),
    changedAtNs: status.ctimeNs.toString(),
    sha256: status.size <= MAXIMUM_HASHED_INPUT_BYTES ? await sha256File(actual) : null,
    changedDuringRun:
      Number(status.size) !== read.size ||
      status.mtimeNs.toString() !== read.modifiedAtNs ||
      (read.changedAtNs !== undefined && status.ctimeNs.toString() !== read.changedAtNs),
  };
}

const isDeclared = (input: ComputeResultInput) =>
  input.origin === "declared" || input.origin === "both";

const MAXIMUM_DECLARED_INPUTS = 1000;
type UnresolvedViewInput = NonNullable<
  ComputeResultRevision["inputs"]["unresolvedViewInputs"]
>[number];

async function expandInputGlob(root: string, pattern: string) {
  const matches: string[] = [];
  for await (const path of NodeFSP.glob(projectInputName(pattern), { cwd: root })) {
    const actual = await projectEntry(root, NodePath.join(root, path));
    if (actual === null) continue;
    if (!(await NodeFSP.stat(actual).catch(() => null))?.isFile()) continue;
    matches.push(toPosix(path));
    if (matches.length > MAXIMUM_DECLARED_INPUTS) break;
  }
  return matches;
}

async function globHash(root: string, pattern: string): Promise<string | null> {
  try {
    return listingHash(await expandInputGlob(root, pattern));
  } catch {
    return null;
  }
}

export async function captureDeclaredInputs(root: string, declared: ReadonlyArray<string>) {
  const sources = new Map<string, string | undefined>();
  for (const path of declared) sources.set(projectInputName(path), undefined);
  const realRoot = await NodeFSP.realpath(root);
  const snapshots: ComputeResultInput[] = [];
  const declaredGlobs = new Map<string, DirectoryInput>();
  const unresolvedViewInputs: UnresolvedViewInput[] = [];
  for (const [path, via] of sources) {
    const target = NodePath.resolve(realRoot, ...path.split("/"));
    const actual = await projectEntry(realRoot, target);
    if (actual === null) throw new Error(`Declared input "${path}" is missing or cannot be read.`);
    const status = await NodeFSP.stat(actual, { bigint: true });
    if (!status.isFile()) throw new Error(`Declared input "${path}" is not a regular file.`);
    const sha256 = status.size <= MAXIMUM_HASHED_INPUT_BYTES ? await sha256File(actual) : null;
    if (via === undefined && isSavedDataView(path)) {
      if (status.size > MAXIMUM_VALUES_FILE_BYTES)
        throw new Error(`Saved view "${path}" is too large to read.`);
      const sql = await NodeFSP.readFile(actual, "utf8");
      const { files, globs, dropped } = savedViewReferences(sql);
      const patterns = new Set(globs);
      for (const _reference of dropped) {
        if (unresolvedViewInputs.length >= MAXIMUM_DECLARED_INPUTS) break;
        unresolvedViewInputs.push({
          via: path,
          reference: "(outside the project)",
          reason: "unrecorded",
        });
      }
      for (const source of [...files, ...globs]) {
        const name = projectInputName(source);
        const glob = patterns.has(source);
        let matches = [name];
        let reason: UnresolvedViewInput["reason"] | undefined;
        if (glob) {
          if (declaredGlobs.has(name)) continue;
          if (declaredGlobs.size >= MAXIMUM_DECLARED_INPUTS) {
            matches = [];
            reason = "limit";
          } else {
            matches = await expandInputGlob(realRoot, name);
            declaredGlobs.set(name, {
              path: name,
              sha256: listingHash(matches),
              changedDuringRun: false,
            });
            if (matches.length === 0) reason = "no-matches";
            else if (matches.length > MAXIMUM_DECLARED_INPUTS) reason = "limit";
          }
        }
        for (const match of matches) {
          if (sources.has(match)) continue;
          if (sources.size >= MAXIMUM_DECLARED_INPUTS) {
            reason = "limit";
            break;
          }
          sources.set(match, path);
        }
        if (reason !== undefined && unresolvedViewInputs.length < MAXIMUM_DECLARED_INPUTS)
          unresolvedViewInputs.push({ via: path, reference: name, reason });
      }
    }
    const after = await NodeFSP.stat(actual, { bigint: true });
    if (
      status.size !== after.size ||
      status.mtimeNs !== after.mtimeNs ||
      status.ctimeNs !== after.ctimeNs
    )
      throw new Error(`Declared input "${path}" changed while Scient was recording it.`);
    snapshots.push({
      path,
      size: Number(status.size),
      modifiedAtNs: status.mtimeNs.toString(),
      changedAtNs: status.ctimeNs.toString(),
      sha256,
      changedDuringRun: false,
      origin: "declared",
      ...(via === undefined ? {} : { via }),
    });
  }
  return {
    declaredSnapshots: snapshots,
    ...(declaredGlobs.size === 0 ? {} : { declaredGlobs: [...declaredGlobs.values()] }),
    ...(unresolvedViewInputs.length === 0 ? {} : { unresolvedViewInputs }),
  };
}

function projectInputName(path: string): string {
  const slashPath = path.replaceAll("\\", "/");
  if (
    NodePath.win32.parse(slashPath).root !== "" ||
    slashPath.includes("\0") ||
    slashPath.split("/").includes("..")
  )
    throw new Error(`Declared input "${path}" must be a project-relative file path.`);
  const normalized = NodePath.posix.normalize(slashPath);
  if (normalized === "." || normalized.endsWith("/"))
    throw new Error(`Declared input "${path}" must be a file.`);
  return normalized;
}

const ROOT_LOCKFILES = new Set([
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "environment.yml",
  "pixi.lock",
  "renv.lock",
  "Project.toml",
  "Manifest.toml",
  "DESCRIPTION",
]);

async function rootLockfileHash(root: string, name: string): Promise<string | null> {
  const path = await NodeFSP.realpath(NodePath.join(root, name)).catch(() => null);
  if (path === null || projectRelative(root, path) === null) return null;
  const status = await NodeFSP.stat(path).catch(() => null);
  return status?.isFile() ? sha256File(path).catch(() => null) : null;
}

async function captureResultEnvironment(root: string): Promise<ComputeResultEnvironment> {
  const realRoot = await NodeFSP.realpath(root);
  const lockfiles: ComputeResultEnvironment["lockfiles"][number][] = [];
  for (const name of (await NodeFSP.readdir(realRoot)).toSorted()) {
    if (!ROOT_LOCKFILES.has(name) && !/^requirements.*\.txt$/u.test(name)) continue;
    const sha256 = await rootLockfileHash(realRoot, name);
    if (sha256 !== null) lockfiles.push({ path: name, sha256 });
  }
  return { lockfiles };
}

const runOverrides = (revision: ComputeResultRevision | undefined) =>
  (revision?.parameters ?? []).filter((parameter) => parameter.source === "override");

const declaredPaths = (revision: ComputeResultRevision | undefined) =>
  (revision?.inputs.files ?? [])
    .filter((input) => isDeclared(input) && input.via === undefined)
    .map((input) => input.path);

const SUGGESTION_COMMENTS: Readonly<Record<string, RegExp>> = {
  ".r": /#[^\r\n]*/u,
  ".jl": /#=[\s\S]*?=#|#[^\r\n]*/u,
  ".sql": /--[^\r\n]*|\/\*[\s\S]*?\*\//u,
  ".m": /%\{[\s\S]*?%\}|%[^\r\n]*/u,
};

export const supportsResultInputSuggestions = (scriptPath: string) =>
  Object.hasOwn(SUGGESTION_COMMENTS, NodePath.extname(scriptPath).toLowerCase());

export async function suggestedResultInputs(root: string, scriptPath: string, code: string) {
  const extension = NodePath.extname(scriptPath).toLowerCase();
  const comments = SUGGESTION_COMMENTS[extension];
  if (comments === undefined) return [];
  const escaped = extension === ".r" || extension === ".jl";
  const quotes = escaped
    ? /"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'/u
    : /"(?:[^"\r\n]|"")*"|'(?:[^'\r\n]|'')*'/u;
  const candidates = new Set<string>();
  for (const [token] of code.matchAll(new RegExp(comments.source + "|" + quotes.source, "gu"))) {
    const quote = token[0];
    if (quote !== '"' && quote !== "'") continue;
    const literal = token.slice(1, -1);
    if (extension === ".jl" && literal.includes("$")) continue;
    if (escaped && /\\[^\\'"]/u.test(literal.replaceAll("\\\\", ""))) continue;
    try {
      const path = projectInputName(
        escaped ? literal.replace(/\\([\\'"])/gu, "$1") : literal.replaceAll(quote + quote, quote),
      );
      if (path !== scriptPath && path.length <= 4096) candidates.add(path);
    } catch {
      // Strings that cannot be project-relative paths are ordinary source text.
    }
    if (candidates.size >= 200) break;
  }
  const realRoot = await NodeFSP.realpath(root);
  const suggestions: string[] = [];
  for (const path of candidates) {
    const actual = await projectEntry(realRoot, NodePath.join(realRoot, ...path.split("/")));
    if (actual !== null && (await NodeFSP.stat(actual).catch(() => null))?.isFile())
      suggestions.push(path);
    if (suggestions.length >= 30) break;
  }
  return suggestions;
}

type ResultRunSetup = {
  readonly parameters: ReadonlyArray<ComputeResultParameter>;
  readonly declaredSnapshots: ReadonlyArray<ComputeResultInput>;
  readonly declaredGlobs?: ReadonlyArray<DirectoryInput>;
  readonly unresolvedViewInputs?: ReadonlyArray<UnresolvedViewInput>;
  readonly environment?: ComputeResultEnvironment;
};

export function scriptParametersJson(
  parameters: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): string | undefined {
  for (const { name, value } of parameters) {
    try {
      JSON.parse(value);
    } catch {
      throw new Error(`Parameter "${name}" needs a JSON value.`);
    }
  }
  const parameterJson =
    parameters.length === 0
      ? undefined
      : `{${parameters.map(({ name, value }) => `${JSON.stringify(name)}:${value}`).join(",")}}`;
  // Individual environment variables have a lower size limit on Windows than the request does.
  if (parameterJson !== undefined && Buffer.byteLength(parameterJson) > 30_000)
    throw new Error("The parameters are too large to pass to the runtime.");
  return parameterJson;
}

export async function prepareResultRun(
  layout: ResultsLayout,
  request: {
    readonly projectId: string;
    readonly root: string;
    readonly scriptPath: string;
    readonly parameters?: Readonly<Record<string, string>> | undefined;
    readonly inputs?: ReadonlyArray<string> | undefined;
  },
): Promise<ResultRunSetup & { readonly parameterJson?: string }> {
  const latest =
    request.parameters === undefined || request.inputs === undefined
      ? (await readRevisions(layout, request.projectId)).find(
          (entry) => entry.script.path === request.scriptPath && isPublishedResultRevision(entry),
        )
      : undefined;
  const parameters =
    request.parameters === undefined
      ? runOverrides(latest)
      : Object.entries(request.parameters).map(([name, value]) => ({
          name,
          value,
          source: "override" as const,
        }));
  const parameterJson = scriptParametersJson(parameters);
  const inputs = request.inputs ?? declaredPaths(latest);
  return {
    parameters,
    ...(inputs.length === 0
      ? { declaredSnapshots: [] }
      : await captureDeclaredInputs(request.root, inputs)),
    environment: await captureResultEnvironment(request.root),
    ...(parameterJson === undefined ? {} : { parameterJson }),
  };
}

const setupPath = (stagingFolder: string) => `${stagingFolder}.json`;

export async function writeResultRunSetup(stagingFolder: string, setup: ResultRunSetup) {
  const { parameters, declaredSnapshots, declaredGlobs, unresolvedViewInputs, environment } = setup;
  await NodeFSP.writeFile(
    setupPath(stagingFolder),
    JSON.stringify({
      parameters,
      declaredSnapshots,
      declaredGlobs,
      unresolvedViewInputs,
      environment,
    }),
  );
}

export async function readResultRunSetup(
  stagingFolder: string,
): Promise<ResultRunSetup | undefined> {
  try {
    return JSON.parse(await NodeFSP.readFile(setupPath(stagingFolder), "utf8")) as ResultRunSetup;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

/**
 * Collects what a fresh script run left in its results folder into one revision. Outputs are
 * copied, not moved, so a hard link or an open handle in the script cannot change them afterwards.
 */
export async function publishScriptRun(
  layout: ResultsLayout,
  run: SettledScriptRun,
): Promise<PublishOutcome> {
  const revisionId = newRevisionId();
  const pending = NodePath.join(revisionsFolder(layout, run.projectId), `.${revisionId}`);
  try {
    if (!run.succeeded) return { _tag: "failed", message: "The run did not succeed." };
    const files = await listFiles(run.stagingFolder);
    if (files.length === 0)
      return {
        _tag: "failed",
        message:
          run.kind === "notebook"
            ? "The notebook did not save any results to publish."
            : "The script wrote nothing to SCIENT_RESULTS_DIR, so no results were published.",
      };
    const outputs: ComputeResultOutput[] = [];
    let bytes = 0;
    for (const name of files) {
      if (outputs.length >= MAXIMUM_OUTPUT_FILES) break;
      const source = NodePath.join(run.stagingFolder, ...name.split("/"));
      // Checked before copying, and again on the copy, which is what the revision keeps.
      if (bytes + (await NodeFSP.stat(source)).size > MAXIMUM_OUTPUT_BYTES) continue;
      const target = NodePath.join(pending, "outputs", ...name.split("/"));
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.copyFile(source, target);
      const size = (await NodeFSP.stat(target)).size;
      if (bytes + size > MAXIMUM_OUTPUT_BYTES) {
        await NodeFSP.rm(target);
        continue;
      }
      const classified = outputKind(name);
      const kind =
        classified.kind === "values" &&
        (size > MAXIMUM_VALUES_FILE_BYTES ||
          readResultValues(await NodeFSP.readFile(target, "utf8")) === null)
          ? "file"
          : classified.kind;
      bytes += size;
      outputs.push({
        name,
        kind,
        mediaType: classified.mediaType,
        sha256: await sha256File(target),
        size,
      });
    }
    const inputs = new Map<string, ComputeResultInput>();
    const declared =
      run.declaredSnapshots === undefined && run.declaredInputs !== undefined
        ? await captureDeclaredInputs(run.root, run.declaredInputs)
        : {
            declaredSnapshots: run.declaredSnapshots ?? [],
            declaredGlobs: run.declaredGlobs,
            unresolvedViewInputs: run.unresolvedViewInputs,
          };
    const realRoot = await NodeFSP.realpath(run.root);
    for (const input of declared.declaredSnapshots) {
      inputs.set(input.path, {
        ...input,
        changedDuringRun: (await fileChanged(realRoot, input)) !== false,
      });
    }
    for (const read of run.reads?.files ?? []) {
      const relative = projectRelative(realRoot, read.path);
      if (relative === null || relative === run.scriptPath) continue;
      const observed = await recordInput(realRoot, read);
      if (observed === null) continue;
      const declared = inputs.get(observed.path);
      inputs.set(
        observed.path,
        declared === undefined
          ? observed
          : {
              ...declared,
              origin: "both",
              changedDuringRun: declared.changedDuringRun || observed.changedDuringRun,
            },
      );
    }
    const directories: DirectoryInput[] = [];
    for (const directory of run.reads?.directories ?? []) {
      const path = directory.path === realRoot ? "." : projectRelative(realRoot, directory.path);
      if (path !== null && !path.split("/").some((part) => placementDirectories.has(part)))
        directories.push({
          path,
          sha256: directory.sha256,
          changedDuringRun: (await directoryHash(realRoot, path)) !== directory.sha256,
        });
    }
    const globs: DirectoryInput[] = [];
    for (const pattern of declared.declaredGlobs ?? []) {
      globs.push({
        ...pattern,
        changedDuringRun: (await globHash(realRoot, pattern.path)) !== pattern.sha256,
      });
    }
    const revision: ComputeResultRevision = decodeRevision({
      revision: revisionId,
      script: {
        path: run.scriptPath,
        language: run.language,
        sha256: sha256Text(run.code),
        ...(run.codeSha256 === undefined ? {} : { codeSha256: run.codeSha256 }),
        ...(run.kind === undefined ? {} : { kind: run.kind }),
      },
      run: {
        sessionId: run.sessionId,
        executionId: run.executionId,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        ...(run.threadId === undefined ? {} : { threadId: run.threadId }),
      },
      runtime: run.runtime,
      inputs: {
        tracking: run.reads === undefined ? "not-tracked" : "observed",
        files: [...inputs.values()],
        ...(run.reads?.directories === undefined
          ? {}
          : { directories, directoryListingVersion: 3 }),
        ...(run.reads?.readsOutsideProject === undefined
          ? {}
          : { readsOutsideProject: run.reads.readsOutsideProject }),
        ...(run.reads?.outsideDataPaths === undefined
          ? {}
          : { outsideDataPaths: run.reads.outsideDataPaths }),
        truncated: run.reads?.truncated === true,
        ...(globs.length === 0 ? {} : { globs }),
        ...(declared.unresolvedViewInputs === undefined
          ? {}
          : { unresolvedViewInputs: declared.unresolvedViewInputs }),
      },
      ...(run.parameters === undefined ? {} : { parameters: run.parameters }),
      ...(run.environment === undefined ? {} : { environment: run.environment }),
      outputs,
      ...(run.publication === undefined ? {} : { publication: run.publication }),
      omitted: files.length - outputs.length,
    });
    await writeRevision(pending, revision);
    await NodeFSP.rename(pending, revisionFolder(layout, run.projectId, revisionId));
    // Retention is housekeeping; a failure here must not undo a published revision.
    await pruneFigureBytes(layout, run.projectId, run.scriptPath).catch(() => undefined);
    return { _tag: "published", revision };
  } finally {
    // Cleanup never changes the outcome: a committed revision stays published.
    await NodeFSP.rm(pending, { recursive: true, force: true }).catch(() => undefined);
    await NodeFSP.rm(run.stagingFolder, { recursive: true, force: true }).catch(() => undefined);
    await NodeFSP.rm(setupPath(run.stagingFolder), { force: true }).catch(() => undefined);
  }
}

async function writeRevision(folder: string, revision: ComputeResultRevision) {
  const target = NodePath.join(folder, "revision.json");
  const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(revision, null, 2)}\n`);
  await NodeFSP.rename(temporary, target);
}

async function readRevisions(
  layout: ResultsLayout,
  projectId: string,
): Promise<ReadonlyArray<ComputeResultRevision>> {
  const folder = revisionsFolder(layout, projectId);
  const names = await NodeFSP.readdir(folder).catch(() => []);
  const revisions: ComputeResultRevision[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    try {
      const text = await NodeFSP.readFile(NodePath.join(folder, name, "revision.json"), "utf8");
      revisions.push(decodeRevision(JSON.parse(text)));
    } catch {
      // A half-written or foreign folder is not a revision.
    }
  }
  return revisions.toSorted(
    (left, right) =>
      right.run.finishedAt.localeCompare(left.run.finishedAt) ||
      right.revision.localeCompare(left.revision),
  );
}

export const isPublishedResultRevision = (revision: ComputeResultRevision): boolean =>
  revision.publication !== "alternative";

async function pruneFigureBytes(layout: ResultsLayout, projectId: string, scriptPath: string) {
  const forScript = (await readRevisions(layout, projectId)).filter(
    (revision) => revision.script.path === scriptPath,
  );
  const published = forScript.find(isPublishedResultRevision);
  const older = forScript
    .filter((revision) => revision !== published)
    .slice(RETAINED_FIGURE_REVISIONS - (published === undefined ? 0 : 1));
  for (const revision of older) {
    if (!revision.outputs.some((output) => output.kind !== "values" && output.pruned !== true))
      continue;
    for (const output of revision.outputs) {
      if (output.kind === "values") continue;
      const path = revisionOutputPath(layout, projectId, revision.revision, output.name);
      if (path !== null) await NodeFSP.rm(path, { force: true });
    }
    await writeRevision(revisionFolder(layout, projectId, revision.revision), {
      ...revision,
      outputs: revision.outputs.map((output) =>
        output.kind === "values" ? output : { ...output, pruned: true },
      ),
    });
  }
}

async function fileChanged(root: string, input: ComputeResultInput): Promise<boolean | null> {
  const path = await projectEntry(root, NodePath.join(root, ...input.path.split("/")));
  if (path === null) return null;
  const status = await NodeFSP.stat(path, { bigint: true }).catch(() => null);
  if (status === null || !status.isFile()) return null;
  if (
    Number(status.size) === input.size &&
    status.mtimeNs.toString() === input.modifiedAtNs &&
    (input.changedAtNs === undefined || status.ctimeNs.toString() === input.changedAtNs)
  )
    return false;
  if (input.sha256 === null) return true;
  return (await sha256File(path)) !== input.sha256;
}

/** What changed since the revision ran, among what Scient records. */
async function revisionCauses(
  root: string,
  revision: ComputeResultRevision,
  lockfileHash: (path: string) => Promise<string | null>,
  readListingHash: (
    path: string,
    kind: "directory" | "legacy-directory" | "glob",
  ) => Promise<string | null>,
): Promise<ReadonlyArray<ComputeResultCause>> {
  const causes: ComputeResultCause[] = [];
  const script = await NodeFSP.readFile(
    NodePath.join(root, ...revision.script.path.split("/")),
  ).catch(() => null);
  if (script === null) causes.push({ kind: "script-missing", path: revision.script.path });
  else {
    let code: string | null = null;
    if (revision.script.kind === "notebook") {
      try {
        code = indexNotebook(script)
          .cells.filter(
            ({ fields }) =>
              fields.cell_type === "code" &&
              (revision.script.codeSha256 === undefined ||
                !notebookCellTags(fields).includes("injected-parameters")),
          )
          .map((cell) => notebookText(cell.fields.source))
          .join("\n");
      } catch {
        // An unreadable notebook cannot match the recorded code.
      }
    } else code = script.toString("utf8");
    if (
      code === null ||
      sha256Text(code) !== (revision.script.codeSha256 ?? revision.script.sha256)
    )
      causes.push({ kind: "script-changed", path: revision.script.path });
  }
  const realRoot = await NodeFSP.realpath(root).catch(() => root);
  for (const input of revision.inputs.files) {
    if (input.changedDuringRun) {
      causes.push({ kind: "input-changed-during-run", path: input.path });
      continue;
    }
    const changed = await fileChanged(realRoot, input);
    if (changed === null) causes.push({ kind: "input-missing", path: input.path });
    else if (changed) causes.push({ kind: "input-changed", path: input.path });
  }
  for (const [kind, listings] of [
    [
      revision.inputs.directoryListingVersion === undefined ? "legacy-directory" : "directory",
      observedDirectoryInputs(revision),
    ],
    ["glob", revision.inputs.globs ?? []],
  ] as const) {
    for (const { path, sha256, changedDuringRun } of listings) {
      if (changedDuringRun) {
        causes.push({ kind: "input-changed-during-run", path });
        continue;
      }
      const current = await readListingHash(path, kind);
      if (current === null) causes.push({ kind: "input-missing", path });
      else if (current !== sha256) causes.push({ kind: "input-changed", path });
    }
  }
  for (const { path, sha256 } of revision.environment?.lockfiles ?? []) {
    if ((await lockfileHash(path)) !== sha256) causes.push({ kind: "lockfile-changed", path });
  }
  return causes;
}

export function summarizeRevision(
  revision: ComputeResultRevision,
  causes: ReadonlyArray<ComputeResultCause>,
): ComputeResultSummary {
  const directories = observedDirectoryInputs(revision);
  const inputsIncomplete =
    revision.inputs.truncated ||
    revision.inputs.unresolvedViewInputs !== undefined ||
    (revision.inputs.outsideDataPaths?.length ?? 0) > 0;
  const inputEvidence = [
    ...revision.inputs.files.map((input) => ["file", input] as const),
    ...directories.map((input) => ["directory", input] as const),
    ...(revision.inputs.globs ?? []).map((input) => ["glob", input] as const),
  ];
  const inputFingerprint =
    inputsIncomplete ||
    inputEvidence.some(([, input]) => input.sha256 === null || input.changedDuringRun)
      ? undefined
      : sha256Text(
          JSON.stringify(
            inputEvidence
              .map(([kind, { path, sha256 }]) => JSON.stringify([kind, path, sha256]))
              .sort(),
          ),
        );
  return {
    revision: revision.revision,
    scriptPath: revision.script.path,
    language: revision.script.language,
    finishedAt: revision.run.finishedAt,
    ...(revision.run.threadId === undefined ? {} : { threadId: revision.run.threadId }),
    runtime: { executable: revision.runtime.executable, version: revision.runtime.version },
    inputTracking: revision.inputs.tracking,
    inputs: revision.inputs.files.map((input) => input.path),
    ...(revision.script.kind === undefined ? {} : { kind: revision.script.kind }),
    ...(revision.parameters === undefined ? {} : { parameters: revision.parameters }),
    declaredInputs: revision.inputs.files.filter(isDeclared).map((input) => input.path),
    derivedInputs: revision.inputs.files
      .filter((input) => input.via !== undefined)
      .map((input) => input.path),
    observedInputCount: revision.inputs.files.filter((input) => input.origin !== "declared").length,
    inputsTruncated: revision.inputs.truncated,
    ...(inputFingerprint === undefined ? {} : { inputFingerprint }),
    ...(revision.inputs.directories === undefined
      ? {}
      : { observedDirectories: directories.map(({ path }) => path) }),
    ...(revision.inputs.readsOutsideProject === undefined
      ? {}
      : { readsOutsideProject: revision.inputs.readsOutsideProject }),
    ...(revision.inputs.outsideDataPaths === undefined
      ? {}
      : { outsideDataPaths: revision.inputs.outsideDataPaths }),
    ...(revision.inputs.unresolvedViewInputs === undefined
      ? {}
      : { unresolvedViewInputCount: revision.inputs.unresolvedViewInputs.length }),
    ...(inputsIncomplete ? { inputCoverageIncomplete: true } : {}),
    causes,
  };
}

/** Reads revisions and checks the project once per request, however many references share them. */
export function makeResultsReader(layout: ResultsLayout, projectId: string, root: string) {
  let revisions: Promise<ReadonlyArray<ComputeResultRevision>> | null = null;
  const all = () => (revisions ??= readRevisions(layout, projectId));
  const latestPublished = async (scriptPath: string) =>
    (await all()).find(
      (candidate) => candidate.script.path === scriptPath && isPublishedResultRevision(candidate),
    );
  const causes = new Map<string, Promise<ReadonlyArray<ComputeResultCause>>>();
  const listingHashes = new Map<string, Promise<string | null>>();
  const readListingHash = (path: string, kind: "directory" | "legacy-directory" | "glob") => {
    const key = `${kind}:${path}`;
    let pending = listingHashes.get(key);
    if (pending === undefined) {
      pending = NodeFSP.realpath(root)
        .then((realRoot) =>
          kind === "glob"
            ? globHash(realRoot, path)
            : directoryHash(realRoot, path, kind === "directory"),
        )
        .catch(() => null);
      listingHashes.set(key, pending);
    }
    return pending;
  };
  const lockfiles = new Map<string, Promise<string | null>>();
  const lockfileHash = (path: string) => {
    let pending = lockfiles.get(path);
    if (pending === undefined) {
      pending = NodeFSP.realpath(root)
        .then((realRoot) => rootLockfileHash(realRoot, path))
        .catch(() => null);
      lockfiles.set(path, pending);
    }
    return pending;
  };
  const attempts = new Map<string, ReturnType<typeof readLastResultAttempt>>();
  const lastAttempt = (scriptPath: string) => {
    let pending = attempts.get(scriptPath);
    if (pending === undefined) {
      pending = latestPublished(scriptPath).then((published) =>
        readLastResultAttempt(layout, projectId, scriptPath, published?.run.finishedAt),
      );
      attempts.set(scriptPath, pending);
    }
    return pending;
  };
  const summary = async (revision: ComputeResultRevision) => {
    let pending = causes.get(revision.revision);
    if (pending === undefined) {
      pending = revisionCauses(root, revision, lockfileHash, readListingHash);
      causes.set(revision.revision, pending);
    }
    const failure = await lastAttempt(revision.script.path);
    return {
      ...summarizeRevision(revision, await pending),
      ...(failure === null
        ? {}
        : {
            lastAttempt: {
              status: failure.status,
              finishedAt: failure.finishedAt,
              message: failure.message,
            },
          }),
    };
  };
  const valuesText = new Map<string, Promise<string | null>>();
  const valueOf = async (
    revision: ComputeResultRevision,
    outputName: string,
    pointer: string | null,
  ): Promise<{
    value: string | null;
    figure: boolean;
    table?: ReadonlyArray<ReadonlyArray<string>> | null;
  }> => {
    const output = revision.outputs.find((candidate) => candidate.name === outputName);
    if (output === undefined) return { value: null, figure: false };
    if (output.kind === "figure") return { value: null, figure: pointer === null };
    if (output.kind === "table") {
      if (pointer !== null || output.pruned === true) return { value: null, figure: false };
      const path = revisionOutputPath(layout, projectId, revision.revision, output.name);
      const text = path === null ? null : await NodeFSP.readFile(path, "utf8").catch(() => null);
      return { value: null, figure: false, table: text === null ? null : parseCsv(text) };
    }
    if (output.kind !== "values" || pointer === null) return { value: null, figure: false };
    const key = `${revision.revision}/${output.name}`;
    let text = valuesText.get(key);
    if (text === undefined) {
      const path = revisionOutputPath(layout, projectId, revision.revision, output.name);
      text =
        path === null ? Promise.resolve(null) : NodeFSP.readFile(path, "utf8").catch(() => null);
      valuesText.set(key, text);
    }
    const contents = await text;
    return { value: contents === null ? null : resultValueAt(contents, pointer), figure: false };
  };

  const resolve = async (reference: ComputeResultReference): Promise<ComputeResultResolution> => {
    const revisions = await all();
    const revision = revisions.find((candidate) => candidate.revision === reference.revision);
    if (revision === undefined) return { _tag: "unrecorded" };
    const newest = await latestPublished(revision.script.path);
    const pinned = await valueOf(revision, reference.output, reference.pointer);
    const newer =
      newest === undefined || revisions.indexOf(newest) >= revisions.indexOf(revision)
        ? null
        : {
            summary: await summary(newest),
            ...(await valueOf(newest, reference.output, reference.pointer)),
          };
    return { _tag: "resolved", summary: await summary(revision), ...pinned, newer };
  };

  const valuesOf = async (revision: ComputeResultRevision) => {
    const values: ComputeResultValue[] = [];
    for (const output of revision.outputs) {
      if (output.kind !== "values") continue;
      const path = revisionOutputPath(layout, projectId, revision.revision, output.name);
      const text = path === null ? null : await NodeFSP.readFile(path, "utf8").catch(() => null);
      for (const leaf of (text === null ? null : readResultValues(text)) ?? [])
        values.push({ output: output.name, pointer: leaf.pointer, value: leaf.value });
    }
    return values;
  };

  const published = async (revision: ComputeResultRevision) => {
    const counts = {
      values: (await valuesOf(revision)).length,
      tables: 0,
      figures: 0,
      files: 0,
    };
    for (const { kind } of revision.outputs) {
      if (kind === "table") counts.tables++;
      else if (kind === "figure") counts.figures++;
      else if (kind !== "values") counts.files++;
    }
    return {
      _tag: "published" as const,
      count: counts.values + counts.tables + counts.figures + counts.files,
      counts,
    };
  };

  const findPublication = async (run: Omit<ComputeResultsPublicationInput, "cwd">) => {
    // Read the pending marker first. Once it disappears the outcome has been recorded.
    if (await isResultAttemptPending(layout, projectId, run)) {
      return { _tag: "pending" as const };
    }
    const revision = (await all()).find(
      (entry) =>
        entry.script.path === run.scriptPath &&
        entry.run.sessionId === run.sessionId &&
        entry.run.executionId === run.executionId,
    );
    if (revision !== undefined) {
      return published(revision);
    }
    const attempt = await readLastResultAttempt(layout, projectId, run.scriptPath, undefined);
    return attempt?.sessionId === run.sessionId && attempt.executionId === run.executionId
      ? { _tag: "failed" as const, message: attempt.message ?? "This run did not publish results." }
      : { _tag: "unavailable" as const };
  };

  const list = async (
    preferCurrent = false,
    revisionId?: string,
  ): Promise<ReadonlyArray<ComputeResultScript>> => {
    const revisionsByScript = Map.groupBy(await all(), (revision) => revision.script.path);
    const scripts: ComputeResultScript[] = [];
    for (const revisions of revisionsByScript.values()) {
      const published = revisions.filter(isPublishedResultRevision);
      const latest =
        revisionId === undefined
          ? published[0]
          : published.find(({ revision }) => revision === revisionId);
      if (latest === undefined) continue;
      let selected = latest;
      let selectedSummary = await summary(latest);
      if (
        revisionId === undefined &&
        preferCurrent &&
        (resultSourceChanged(selectedSummary) || resultInputCoverageIncomplete(selectedSummary))
      ) {
        for (const revision of published.slice(1)) {
          const candidate = await summary(revision);
          if (resultSourceChanged(candidate) || resultInputCoverageIncomplete(candidate)) continue;
          selected = revision;
          selectedSummary = candidate;
          break;
        }
      }
      const failure = await lastAttempt(selected.script.path);
      scripts.push({
        latest: selectedSummary,
        lastAttempt:
          failure === null || selectedSummary.lastAttempt === undefined
            ? null
            : {
                ...selectedSummary.lastAttempt,
                sessionId: failure.sessionId,
                ...(failure.hasExecution ? { executionId: failure.executionId } : {}),
              },
        values: await valuesOf(selected),
        figures: selected.outputs
          .filter((output) => output.kind === "figure" && output.pruned !== true)
          .map((output) => output.name),
        tables: selected.outputs
          .filter(
            (output) =>
              (output.kind === "table" || output.kind === "latex") && output.pruned !== true,
          )
          .map((output) => output.name),
        revisions: revisions.length,
      });
    }
    return scripts;
  };

  const figure = async (revisionId: string, outputName: string) => {
    const revision = (await all()).find((candidate) => candidate.revision === revisionId);
    const output = revision?.outputs.find(
      (candidate) => candidate.name === outputName && candidate.kind === "figure",
    );
    if (revision === undefined || output === undefined || output.pruned === true) return null;
    const path = revisionOutputPath(layout, projectId, revision.revision, output.name);
    return path === null ? null : { path, sha256: output.sha256 };
  };

  /** A stored output's file, for any kind, or null when it is unknown or pruned. */
  const outputFile = async (revision: ComputeResultRevision, outputName: string) => {
    const output = revision.outputs.find((candidate) => candidate.name === outputName);
    if (output === undefined || output.pruned === true) return null;
    const path = revisionOutputPath(layout, projectId, revision.revision, output.name);
    return path === null ? null : { path, output };
  };

  const checkedOutputFile = async (revisionId: string, outputName: string) => {
    const stored = (await all()).find(({ revision }) => revision === revisionId);
    const metadata = stored?.outputs.find(({ name }) => name === outputName);
    if (stored === undefined || metadata === undefined)
      return { _tag: "unavailable", reason: "missing" } as const;
    if (metadata.pruned === true) return { _tag: "unavailable", reason: "pruned" } as const;
    const file = await outputFile(stored, outputName);
    if (file === null) return { _tag: "unavailable", reason: "missing" } as const;
    const [path, status, realCompute] = await Promise.all([
      NodeFSP.realpath(file.path).catch(() => null),
      NodeFSP.lstat(file.path).catch(() => null),
      NodeFSP.realpath(layout.computeDir),
    ]);
    const outputRoot = NodePath.join(
      realCompute,
      "results",
      projectId,
      "revisions",
      stored.revision,
      "outputs",
    );
    if (path === null || !status?.isFile() || !path.startsWith(`${outputRoot}${NodePath.sep}`))
      return { _tag: "unavailable", reason: "missing" } as const;
    return { _tag: "file", path, status, metadata, revision: stored.revision } as const;
  };

  const outputContent = async (
    revision: string,
    output: string,
  ): Promise<ComputeResultOutputContent> => {
    const file = await checkedOutputFile(revision, output);
    if (file._tag === "unavailable") return file;
    const cap = 16 * 1024;
    const buffer = Buffer.alloc(cap + 1);
    const handle = await NodeFSP.open(file.path, "r");
    let count = 0;
    try {
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
        if (bytesRead === 0) break;
        count += bytesRead;
      }
    } finally {
      await handle.close();
    }
    const truncated = count > cap;
    const bytes = buffer.subarray(0, Math.min(count, cap));
    const { mediaType } = file.metadata;
    const text =
      mediaType.startsWith("text/") ||
      mediaType === "application/json" ||
      mediaType === "image/svg+xml";
    return {
      _tag: "content",
      revision: file.revision,
      output,
      mediaType,
      encoding: text ? "utf8" : "base64",
      content: text
        ? new TextDecoder().decode(bytes, { stream: truncated })
        : bytes.toString("base64"),
      truncated,
    };
  };

  const setup = async (scriptPath: string) => {
    const latest = await latestPublished(scriptPath);
    return { parameters: runOverrides(latest), inputs: declaredPaths(latest) };
  };

  return {
    resolve,
    list,
    setup,
    figure,
    revisions: all,
    latestPublished,
    summary,
    outputFile,
    checkedOutputFile,
    outputContent,
    lastAttempt,
    findPublication,
    published,
  };
}

export type ResultsReader = ReturnType<typeof makeResultsReader>;
