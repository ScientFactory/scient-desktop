// @effect-diagnostics nodeBuiltinImport:off -- revisions are files under Scient's compute state, hashed and moved with Node.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ComputeResultCause,
  ComputeResultInput,
  ComputeResultOutput,
  ComputeResultOutputKind,
  ComputeResultReference,
  ComputeResultResolution,
  ComputeResultRevision,
  ComputeResultScript,
  ComputeResultSummary,
  ComputeResultValue,
} from "@t3tools/contracts";
import { ComputeResultRevision as ComputeResultRevisionSchema } from "@t3tools/contracts";
import { readResultValues, resultValueAt } from "@t3tools/shared/computeResults";
import * as Schema from "effect/Schema";

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

async function sha256File(path: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk as Buffer);
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
  if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative)) return null;
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
  readonly scriptPath: string;
  readonly language: string;
  readonly code: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly startedAt: string | null;
  readonly finishedAt: string;
  readonly threadId: string | undefined;
  readonly runtime: ComputeResultRevision["runtime"];
  readonly reads:
    | {
        readonly files: ReadonlyArray<{
          readonly path: string;
          readonly size: number;
          readonly modifiedAtNs: string;
          readonly changedAtNs?: string | undefined;
        }>;
        readonly truncated: boolean;
      }
    | undefined;
}

export type PublishOutcome =
  | { readonly _tag: "published"; readonly revision: ComputeResultRevision }
  | { readonly _tag: "failed"; readonly message: string };

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
  const status = await NodeFSP.stat(read.path, { bigint: true }).catch(() => null);
  if (status === null || !status.isFile())
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
    sha256: status.size <= MAXIMUM_HASHED_INPUT_BYTES ? await sha256File(read.path) : null,
    changedDuringRun:
      Number(status.size) !== read.size ||
      status.mtimeNs.toString() !== read.modifiedAtNs ||
      (read.changedAtNs !== undefined && status.ctimeNs.toString() !== read.changedAtNs),
  };
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
        message: "The script wrote nothing to SCIENT_RESULTS_DIR, so no results were published.",
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
    const inputs: ComputeResultInput[] = [];
    for (const read of run.reads?.files ?? []) {
      const input = await recordInput(run.root, read);
      if (input !== null && input.path !== run.scriptPath) inputs.push(input);
    }
    const revision: ComputeResultRevision = decodeRevision({
      revision: revisionId,
      script: { path: run.scriptPath, language: run.language, sha256: sha256Text(run.code) },
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
        files: inputs,
        truncated: run.reads?.truncated === true,
      },
      outputs,
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

async function pruneFigureBytes(layout: ResultsLayout, projectId: string, scriptPath: string) {
  const older = (await readRevisions(layout, projectId))
    .filter((revision) => revision.script.path === scriptPath)
    .slice(RETAINED_FIGURE_REVISIONS);
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
  const path = NodePath.join(root, ...input.path.split("/"));
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
): Promise<ReadonlyArray<ComputeResultCause>> {
  const causes: ComputeResultCause[] = [];
  const script = await NodeFSP.readFile(
    NodePath.join(root, ...revision.script.path.split("/")),
    "utf8",
  ).catch(() => null);
  if (script === null) causes.push({ kind: "script-missing", path: revision.script.path });
  else if (sha256Text(script) !== revision.script.sha256)
    causes.push({ kind: "script-changed", path: revision.script.path });
  for (const input of revision.inputs.files) {
    if (input.changedDuringRun) {
      causes.push({ kind: "input-changed-during-run", path: input.path });
      continue;
    }
    const changed = await fileChanged(root, input);
    if (changed === null) causes.push({ kind: "input-missing", path: input.path });
    else if (changed) causes.push({ kind: "input-changed", path: input.path });
  }
  return causes;
}

export function summarizeRevision(
  revision: ComputeResultRevision,
  causes: ReadonlyArray<ComputeResultCause>,
): ComputeResultSummary {
  return {
    revision: revision.revision,
    scriptPath: revision.script.path,
    language: revision.script.language,
    finishedAt: revision.run.finishedAt,
    ...(revision.run.threadId === undefined ? {} : { threadId: revision.run.threadId }),
    runtime: { executable: revision.runtime.executable, version: revision.runtime.version },
    inputTracking: revision.inputs.tracking,
    inputs: revision.inputs.files.map((input) => input.path),
    inputsTruncated: revision.inputs.truncated,
    causes,
  };
}

/** Reads revisions and checks the project once per request, however many references share them. */
export function makeResultsReader(layout: ResultsLayout, projectId: string, root: string) {
  let revisions: Promise<ReadonlyArray<ComputeResultRevision>> | null = null;
  const all = () => (revisions ??= readRevisions(layout, projectId));
  const causes = new Map<string, Promise<ReadonlyArray<ComputeResultCause>>>();
  const summary = async (revision: ComputeResultRevision) => {
    let pending = causes.get(revision.revision);
    if (pending === undefined) {
      pending = revisionCauses(root, revision);
      causes.set(revision.revision, pending);
    }
    return summarizeRevision(revision, await pending);
  };
  const valuesText = new Map<string, Promise<string | null>>();
  const valueOf = async (
    revision: ComputeResultRevision,
    outputName: string,
    pointer: string | null,
  ): Promise<{ value: string | null; figure: boolean }> => {
    const output = revision.outputs.find((candidate) => candidate.name === outputName);
    if (output === undefined) return { value: null, figure: false };
    if (output.kind === "figure") return { value: null, figure: pointer === null };
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
    const newest = revisions.find((candidate) => candidate.script.path === revision.script.path);
    const pinned = await valueOf(revision, reference.output, reference.pointer);
    const newer =
      newest === undefined || newest.revision === revision.revision
        ? null
        : {
            summary: await summary(newest),
            ...(await valueOf(newest, reference.output, reference.pointer)),
          };
    return { _tag: "resolved", summary: await summary(revision), ...pinned, newer };
  };

  const list = async (): Promise<ReadonlyArray<ComputeResultScript>> => {
    const revisions = await all();
    const scripts: ComputeResultScript[] = [];
    for (const latest of revisions) {
      if (scripts.some((script) => script.latest.scriptPath === latest.script.path)) continue;
      const values: ComputeResultValue[] = [];
      for (const output of latest.outputs) {
        if (output.kind !== "values") continue;
        const path = revisionOutputPath(layout, projectId, latest.revision, output.name);
        const text = path === null ? null : await NodeFSP.readFile(path, "utf8").catch(() => null);
        for (const leaf of (text === null ? null : readResultValues(text)) ?? [])
          values.push({ output: output.name, pointer: leaf.pointer, value: leaf.value });
      }
      scripts.push({
        latest: await summary(latest),
        values,
        figures: latest.outputs
          .filter((output) => output.kind === "figure" && output.pruned !== true)
          .map((output) => output.name),
        revisions: revisions.filter((candidate) => candidate.script.path === latest.script.path)
          .length,
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

  return { resolve, list, figure };
}
