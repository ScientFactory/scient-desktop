// @effect-diagnostics nodeBuiltinImport:off -- the placement record and Undo copies are files under Scient's compute state.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ComputeResultFileState,
  ComputeResultPlacedScript,
  ComputeResultRevision,
  ComputeResultsFilesChangeResult,
  ComputeResultsPlaceLatexResult,
  ComputeResultsPlacementsResult,
} from "@t3tools/contracts";
import { readResultValues } from "@t3tools/shared/computeResults";
import * as Schema from "effect/Schema";

import {
  csvTabularFile,
  defaultMacroName,
  escapeLatexText,
  outputSlug,
  parseCsv,
  uniqueMacroName,
  valuesTexFile,
} from "./latexOutputs.ts";
import type { ResultsLayout, ResultsReader } from "./resultRevisions.ts";

/**
 * LaTeX papers take results as ordinary files at stable paths, `results/<script>/…` beside the
 * root document. Scient records what it placed, from which revision, with which bytes, so it can
 * say whether a file still matches its run and replace a script's files together on request.
 */

/** Project files as the placement code sees them; the server passes its guarded workspace writer. */
export interface ProjectFiles {
  /** A regular file inside the project, or null. */
  readonly read: (path: string) => Promise<Uint8Array | null>;
  /**
   * Writes when the file is still what the caller saw: absent for null, those bytes for a hash.
   * False when it changed; other failures throw, such as a file another program holds open.
   */
  readonly write: (
    path: string,
    bytes: Uint8Array,
    expectedSha256: string | null,
  ) => Promise<boolean>;
}

type PlacementSource =
  | { readonly kind: "values" }
  | { readonly kind: "table"; readonly output: string }
  | { readonly kind: "copy"; readonly output: string };

interface PlacedFileRecord {
  readonly path: string;
  /** The root document's folder the file was placed for; "" at the project root. */
  readonly root: string;
  readonly script: string;
  readonly revision: string;
  readonly source: PlacementSource;
  readonly sha256: string;
  readonly placedAt: string;
}

interface MacroRecord {
  readonly script: string;
  readonly output: string;
  readonly pointer: string;
  readonly macro: string;
}

interface UpdateRecord {
  readonly id: string;
  readonly script: string;
  readonly root: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    /** What the file held before, kept under the Undo folder; null when it was missing. */
    readonly before: { readonly sha256: string; readonly copy: string } | null;
    readonly after: string;
    readonly previous: PlacedFileRecord;
  }>;
}

interface PlacementRecord {
  readonly version: 1;
  /** Script path → its folder name under `results/`. */
  readonly folders: Readonly<Record<string, string>>;
  readonly macros: ReadonlyArray<MacroRecord>;
  readonly files: ReadonlyArray<PlacedFileRecord>;
  /** The last Update files per script and root, which Undo update reverses. */
  readonly updates: ReadonlyArray<UpdateRecord>;
}

const EMPTY_RECORD: PlacementRecord = {
  version: 1,
  folders: {},
  macros: [],
  files: [],
  updates: [],
};

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const recordFolder = (layout: ResultsLayout, projectId: string) =>
  NodePath.join(layout.computeDir, "results", projectId);
const recordPath = (layout: ResultsLayout, projectId: string) =>
  NodePath.join(recordFolder(layout, projectId), "placements.json");
const undoFolder = (layout: ResultsLayout, projectId: string, updateId: string) =>
  NodePath.join(recordFolder(layout, projectId), "placement-undo", updateId);

async function readRecord(layout: ResultsLayout, projectId: string): Promise<PlacementRecord> {
  const text = await NodeFSP.readFile(recordPath(layout, projectId), "utf8").catch(() => null);
  if (text === null) return EMPTY_RECORD;
  const parsed = JSON.parse(text) as PlacementRecord;
  return parsed.version === 1 ? parsed : EMPTY_RECORD;
}

async function writeRecord(layout: ResultsLayout, projectId: string, record: PlacementRecord) {
  const target = recordPath(layout, projectId);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
  await NodeFSP.rename(temporary, target);
}

/** One change at a time per project, so two placements never interleave their record writes. */
const queues = new Map<string, Promise<unknown>>();
function serialized<A>(projectId: string, task: () => Promise<A>): Promise<A> {
  const previous = queues.get(projectId) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    projectId,
    next.catch(() => undefined),
  );
  return next;
}

/** A request Scient will not carry out, with the reason the app shows as it is. */
export class PlacementRefusal extends Schema.TaggedError<PlacementRefusal>()("PlacementRefusal", {
  message: Schema.String,
}) {}
export const isPlacementRefusal = Schema.is(PlacementRefusal);

/** The folder LaTeX resolves paths from: the root document's. */
const documentRoot = (documentPath: string) => {
  const folder = NodePath.posix.dirname(documentPath.replaceAll("\\", "/"));
  return folder === "." ? "" : folder;
};

const inRoot = (root: string, relative: string) =>
  root === "" ? relative : NodePath.posix.join(root, relative);

/** Macro names a document already defines, so generated names never shadow them. */
function definedMacros(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  const pattern =
    /\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\s*\\([A-Za-z]+)|\\[egx]?def\s*\\([A-Za-z]+)|\\(?:New|Renew|Provide|Declare)DocumentCommand\s*\{?\s*\\([A-Za-z]+)/gu;
  for (const match of text.matchAll(pattern)) names.add(match[1] ?? match[2] ?? match[3]!);
  return names;
}

export interface PlacementContext {
  readonly layout: ResultsLayout;
  readonly projectId: string;
  readonly reader: ResultsReader;
  readonly files: ProjectFiles;
}

async function revisionById(context: PlacementContext, id: string) {
  return (await context.reader.revisions()).find((candidate) => candidate.revision === id);
}

async function latestFor(context: PlacementContext, script: string) {
  return (await context.reader.revisions()).find((candidate) => candidate.script.path === script);
}

/** Every value a revision's values files hold, keyed `output#pointer`. */
async function revisionValues(
  context: PlacementContext,
  revision: ComputeResultRevision,
): Promise<ReadonlyArray<{ output: string; pointer: string; value: string }>> {
  const values: { output: string; pointer: string; value: string }[] = [];
  for (const output of revision.outputs) {
    if (output.kind !== "values") continue;
    const stored = await context.reader.outputFile(revision, output.name);
    if (stored === null) continue;
    const text = await NodeFSP.readFile(stored.path, "utf8").catch(() => null);
    for (const leaf of (text === null ? null : readResultValues(text)) ?? [])
      values.push({ output: output.name, pointer: leaf.pointer, value: leaf.value });
  }
  return values;
}

/** Names every value of a revision, keeping names already given and avoiding taken ones. */
function nameValues(
  record: PlacementRecord,
  script: string,
  values: ReadonlyArray<{ output: string; pointer: string }>,
  documentMacros: ReadonlySet<string>,
): { macros: ReadonlyArray<MacroRecord>; names: ReadonlyArray<string> } {
  const macros = [...record.macros];
  const taken = new Set([...documentMacros, ...macros.map((macro) => macro.macro)]);
  const names = values.map((value) => {
    const known = macros.find(
      (macro) =>
        macro.script === script && macro.output === value.output && macro.pointer === value.pointer,
    );
    if (known !== undefined) return known.macro;
    const macro = uniqueMacroName(defaultMacroName(script, value.output, value.pointer), taken);
    taken.add(macro);
    macros.push({ script, output: value.output, pointer: value.pointer, macro });
    return macro;
  });
  return { macros, names };
}

/** The bytes a placed file should hold for a revision, or why that revision cannot make it. */
async function placedBytes(
  context: PlacementContext,
  record: PlacementRecord,
  script: string,
  source: PlacementSource,
  revision: ComputeResultRevision,
  documentMacros: ReadonlySet<string>,
): Promise<
  | { readonly bytes: Uint8Array; readonly macros: ReadonlyArray<MacroRecord> }
  | { readonly refused: string }
> {
  if (source.kind === "values") {
    const values = await revisionValues(context, revision);
    if (values.length === 0) return { refused: `The run of ${script} has no values.` };
    const named = nameValues(record, script, values, documentMacros);
    const text = valuesTexFile({
      scriptPath: script,
      revision: revision.revision,
      finishedAt: revision.run.finishedAt,
      values: values.map((value, index) => ({ macro: named.names[index]!, value: value.value })),
    });
    return { bytes: encode(text), macros: named.macros };
  }
  const stored = await context.reader.outputFile(revision, source.output);
  if (stored === null)
    return { refused: `The run of ${script} has no ${source.output}, or no longer stores it.` };
  const bytes = new Uint8Array(await NodeFSP.readFile(stored.path));
  if (source.kind === "copy") return { bytes, macros: record.macros };
  const rows = parseCsv(decode(bytes));
  if (rows === null)
    return {
      refused: `${source.output} is not a table Scient can print: every row needs the same number of cells, up to 40 columns and 500 rows.`,
    };
  return {
    bytes: encode(
      csvTabularFile({
        scriptPath: script,
        revision: revision.revision,
        finishedAt: revision.run.finishedAt,
        rows,
      }),
    ),
    macros: record.macros,
  };
}

function scriptFolder(record: PlacementRecord, script: string): string {
  const known = record.folders[script];
  if (known !== undefined) return known;
  const taken = new Set(Object.values(record.folders));
  const base = outputSlug(script);
  let name = base;
  for (let index = 2; taken.has(name); index += 1) name = `${base}-${index}`;
  return name;
}

const humanCaption = (output: string) =>
  outputSlug(output)
    .replace(/[-_]+/gu, " ")
    .replace(/(?<=[a-z])(?=[0-9])/gu, " ")
    .replace(/^./u, (first) => first.toUpperCase());

/**
 * Places one value, table or figure for a LaTeX paper and returns what to insert. All results from
 * one script in a paper come from one run, so a script whose files come from an older run must be
 * updated first.
 */
export function placeLatexResult(
  context: PlacementContext,
  request: {
    readonly documentPath: string;
    readonly documentText: string;
    readonly revision: string;
    readonly output: string;
    readonly pointer: string | null;
    readonly now: string;
  },
): Promise<ComputeResultsPlaceLatexResult> {
  return serialized(context.projectId, async () => {
    const revision = await revisionById(context, request.revision);
    if (revision === undefined)
      throw new PlacementRefusal({ message: "This run is not recorded on this computer." });
    const output = revision.outputs.find((candidate) => candidate.name === request.output);
    if (output === undefined)
      throw new PlacementRefusal({ message: `The run has no ${request.output}.` });
    const script = revision.script.path;
    const root = documentRoot(request.documentPath);
    let record = await readRecord(context.layout, context.projectId);
    const placedForScript = record.files.filter(
      (file) => file.script === script && file.root === root,
    );
    if (placedForScript.some((file) => file.revision !== revision.revision))
      throw new PlacementRefusal({
        message: `Results from ${script} in this paper come from another run. Update files first, so they all come from one run.`,
      });
    const folder = scriptFolder(record, script);
    const relativeFolder = `results/${folder}`;
    const source: PlacementSource =
      output.kind === "values"
        ? { kind: "values" }
        : output.kind === "table"
          ? { kind: "table", output: output.name }
          : output.kind === "figure" || output.kind === "latex"
            ? { kind: "copy", output: output.name }
            : (() => {
                throw new PlacementRefusal({
                  message: `${output.name} is not a value, table or figure.`,
                });
              })();
    if (source.kind === "values" && request.pointer === null)
      throw new PlacementRefusal({ message: "Choose a value from the values file." });
    const fileName =
      source.kind === "values"
        ? "values.tex"
        : source.kind === "table"
          ? `${outputSlug(output.name)}.tex`
          : output.name.split("/").at(-1)!;
    const relativePath = `${relativeFolder}/${fileName}`;
    const path = inRoot(root, relativePath);
    const documentMacros = definedMacros(request.documentText);
    const made = await placedBytes(context, record, script, source, revision, documentMacros);
    if ("refused" in made) throw new PlacementRefusal({ message: made.refused });

    const existing = record.files.find((file) => file.path === path);
    const onDisk = await context.files.read(path);
    if (existing === undefined) {
      if (onDisk !== null && sha256(onDisk) !== sha256(made.bytes))
        throw new PlacementRefusal({
          message: `${path} already exists and was not placed by Scient. Move it, or rename the output.`,
        });
      if (onDisk === null && !(await context.files.write(path, made.bytes, null)))
        throw new PlacementRefusal({
          message: `${path} appeared while Scient was writing it. Try again.`,
        });
    } else if (onDisk === null) {
      if (!(await context.files.write(path, made.bytes, null)))
        throw new PlacementRefusal({
          message: `${path} appeared while Scient was writing it. Try again.`,
        });
    }
    // A file placed earlier from this run stays as it is, hand edits included; its state shows them.

    record = {
      ...record,
      folders: { ...record.folders, [script]: folder },
      macros: made.macros,
      files:
        existing === undefined || onDisk === null
          ? [
              ...record.files.filter((file) => file.path !== path),
              {
                path,
                root,
                script,
                revision: revision.revision,
                source,
                sha256: sha256(made.bytes),
                placedAt: request.now,
              },
            ]
          : record.files,
    };
    await writeRecord(context.layout, context.projectId, record);

    if (source.kind === "values") {
      const macro = made.macros.find(
        (candidate) =>
          candidate.script === script &&
          candidate.output === output.name &&
          candidate.pointer === request.pointer,
      );
      if (macro === undefined)
        throw new PlacementRefusal({ message: "The run has no such value." });
      const value = (await revisionValues(context, revision)).find(
        (candidate) => candidate.output === output.name && candidate.pointer === request.pointer,
      );
      return {
        // Braced, so the space after it survives: TeX drops a space after a bare control word,
        // and editors drop an empty `{}` when they rewrite a paragraph.
        insert: { kind: "inline", source: `{\\${macro.macro}}` },
        macro: { name: macro.macro, definition: escapeLatexText(value?.value ?? "") },
        preambleInput: `\\input{${relativePath}}`,
        packages: [],
        files: [path],
      };
    }
    const label = outputSlug(output.name);
    const caption = humanCaption(output.name);
    if (source.kind === "copy" && output.kind === "figure")
      return {
        insert: {
          kind: "block",
          source: [
            "\\begin{figure}[htbp]",
            "\\centering",
            `\\includegraphics[width=0.8\\textwidth]{${relativePath}}`,
            `\\caption{${caption}}`,
            `\\label{fig:${label}}`,
            "\\end{figure}",
          ].join("\n"),
        },
        macro: null,
        preambleInput: null,
        packages: ["graphicx"],
        files: [path],
      };
    // A .tex the script wrote may already be a whole float; then it goes in as it is.
    const whole = source.kind === "copy" && /\\begin\s*\{table\*?\}/u.test(decode(made.bytes));
    return {
      insert: {
        kind: "block",
        source: whole
          ? `\\input{${relativePath}}`
          : [
              "\\begin{table}[htbp]",
              "\\centering",
              `\\caption{${caption}}`,
              `\\label{tab:${label}}`,
              `\\input{${relativePath}}`,
              "\\end{table}",
            ].join("\n"),
      },
      macro: null,
      preambleInput: null,
      // A script's own .tex may use anything; Scient's tables use booktabs rules.
      packages: source.kind === "table" ? ["booktabs"] : [],
      files: [path],
    };
  });
}

async function fileState(
  context: PlacementContext,
  file: PlacedFileRecord,
  outOfDate: boolean,
): Promise<ComputeResultFileState> {
  const bytes = await context.files.read(file.path);
  if (bytes === null) return "missing";
  if (sha256(bytes) !== file.sha256) return "edited";
  return outOfDate ? "out-of-date" : "current";
}

/** Why the newest run cannot replace a script's placed files, or null when it can. */
async function updateRefusal(
  context: PlacementContext,
  record: PlacementRecord,
  files: ReadonlyArray<PlacedFileRecord>,
  from: ComputeResultRevision,
  to: ComputeResultRevision,
): Promise<string | null> {
  for (const file of files) {
    const source = file.source;
    if (source.kind === "values") {
      const before = await revisionValues(context, from);
      const after = new Set(
        (await revisionValues(context, to)).map((value) => `${value.output}#${value.pointer}`),
      );
      const gone = before.filter((value) => !after.has(`${value.output}#${value.pointer}`));
      if (gone.length > 0) {
        const names = gone.map((value) => {
          const macro = record.macros.find(
            (candidate) =>
              candidate.script === file.script &&
              candidate.output === value.output &&
              candidate.pointer === value.pointer,
          );
          return `${value.pointer.slice(1) || value.output}${macro === undefined ? "" : ` (\\${macro.macro})`}`;
        });
        return `The newer run no longer produces ${names.join(", ")}.`;
      }
      continue;
    }
    const output = to.outputs.find((candidate) => candidate.name === source.output);
    if (output === undefined || output.pruned === true)
      return `The newer run no longer writes ${source.output}.`;
    if (source.kind === "table") {
      const stored = await context.reader.outputFile(to, output.name);
      const text = stored === null ? null : await NodeFSP.readFile(stored.path, "utf8");
      if (text === null || parseCsv(text) === null)
        return `The newer run's ${output.name} is not a table Scient can print.`;
    }
  }
  return null;
}

const MAXIMUM_LISTED_CHANGES = 8;

/** What replacing a script's placed files with a newer run would change, line by line. */
async function updateChanges(
  context: PlacementContext,
  record: PlacementRecord,
  files: ReadonlyArray<PlacedFileRecord>,
  from: ComputeResultRevision,
  to: ComputeResultRevision,
): Promise<ReadonlyArray<string>> {
  const lines: string[] = [];
  for (const file of files) {
    const name = file.path.split("/").at(-1)!;
    if (file.source.kind === "values") {
      const after = new Map(
        (await revisionValues(context, to)).map((value) => [
          `${value.output}#${value.pointer}`,
          value.value,
        ]),
      );
      for (const value of await revisionValues(context, from)) {
        const next = after.get(`${value.output}#${value.pointer}`);
        if (next === undefined || next === value.value) continue;
        const macro = record.macros.find(
          (candidate) =>
            candidate.script === file.script &&
            candidate.output === value.output &&
            candidate.pointer === value.pointer,
        );
        lines.push(
          `${macro === undefined ? value.pointer.slice(1) : `\\${macro.macro}`}: ${value.value} → ${next}`,
        );
      }
      continue;
    }
    const before = await context.reader.outputFile(from, file.source.output);
    const after = await context.reader.outputFile(to, file.source.output);
    if (after === null || before?.output.sha256 === after.output.sha256) continue;
    if (file.source.kind === "table" && before !== null) {
      const old = parseCsv(await NodeFSP.readFile(before.path, "utf8"));
      const next = parseCsv(await NodeFSP.readFile(after.path, "utf8"));
      if (old !== null && next !== null && old.length === next.length) {
        let cells = 0;
        for (const [row, cellsBefore] of old.entries())
          for (const [column, cell] of cellsBefore.entries())
            if (next[row]?.[column] !== cell) cells += 1;
        lines.push(`${name}: ${cells} ${cells === 1 ? "cell changes" : "cells change"}`);
        continue;
      }
    }
    lines.push(`${name} changes`);
  }
  return lines.length > MAXIMUM_LISTED_CHANGES
    ? [
        ...lines.slice(0, MAXIMUM_LISTED_CHANGES),
        `and ${lines.length - MAXIMUM_LISTED_CHANGES} more`,
      ]
    : lines;
}

/** Placed files under a paper's root, grouped by script, with what Update files would do. */
export async function placementStatus(
  context: PlacementContext,
  request: {
    readonly documentPath: string;
    readonly build: {
      readonly finishedAt: string;
      readonly digests: Readonly<Record<string, string>>;
    } | null;
  },
): Promise<ComputeResultsPlacementsResult> {
  const root = documentRoot(request.documentPath);
  const record = await readRecord(context.layout, context.projectId);
  const scripts: ComputeResultPlacedScript[] = [];
  const grouped = new Map<string, PlacedFileRecord[]>();
  for (const file of record.files) {
    if (file.root !== root) continue;
    grouped.set(file.script, [...(grouped.get(file.script) ?? []), file]);
  }
  for (const [script, files] of grouped) {
    const revision = await revisionById(context, files[0]!.revision);
    if (revision === undefined) continue;
    const summary = await context.reader.summary(revision);
    const latest = await latestFor(context, script);
    const newer = latest === undefined || latest.revision === revision.revision ? null : latest;
    const placed = [];
    for (const file of files) {
      const state = await fileState(context, file, summary.causes.length > 0);
      const built = request.build?.digests[file.path];
      placed.push({
        path: file.path,
        state,
        differsFromBuild:
          request.build !== null &&
          state !== "missing" &&
          ((built !== undefined && built !== `sha256:${file.sha256}`) ||
            file.placedAt > request.build.finishedAt),
      });
    }
    const update = record.updates.find(
      (candidate) => candidate.script === script && candidate.root === root,
    );
    let canUndo = false;
    if (update !== undefined) {
      canUndo = true;
      for (const file of update.files) {
        const bytes = await context.files.read(file.path);
        if (bytes === null || sha256(bytes) !== file.after) canUndo = false;
      }
    }
    const updateBlocked =
      newer === null ? null : await updateRefusal(context, record, files, revision, newer);
    scripts.push({
      summary,
      newer: newer === null ? null : await context.reader.summary(newer),
      updateBlocked,
      changes:
        newer === null || updateBlocked !== null
          ? []
          : await updateChanges(context, record, files, revision, newer),
      files: placed,
      canUndo,
    });
  }
  return { scripts, coverage: request.build === null ? "placed" : "build" };
}

/**
 * Replaces every file a script placed for a paper with the newest run's, as one change: all are
 * written, or none stay written. The previous bytes, hand edits included, are kept for Undo.
 */
export function updatePlacedFiles(
  context: PlacementContext,
  request: {
    readonly documentPath: string;
    readonly documentText: string;
    readonly script: string;
    readonly replaceEdited: boolean;
    readonly now: string;
  },
): Promise<ComputeResultsFilesChangeResult> {
  return serialized(context.projectId, async () => {
    const root = documentRoot(request.documentPath);
    const record = await readRecord(context.layout, context.projectId);
    const files = record.files.filter(
      (file) => file.script === request.script && file.root === root,
    );
    if (files.length === 0)
      return {
        _tag: "refused",
        message: `No results from ${request.script} are in this paper.`,
        edited: [],
      };
    const from = await revisionById(context, files[0]!.revision);
    const to = await latestFor(context, request.script);
    if (from === undefined || to === undefined)
      return { _tag: "refused", message: "This run is not recorded on this computer.", edited: [] };
    if (to.revision === from.revision)
      return {
        _tag: "refused",
        message: "These files already come from the newest run.",
        edited: [],
      };
    const refusal = await updateRefusal(context, record, files, from, to);
    if (refusal !== null) return { _tag: "refused", message: refusal, edited: [] };

    const documentMacros = definedMacros(request.documentText);
    let macros = record.macros;
    const plan: {
      file: PlacedFileRecord;
      current: Uint8Array | null;
      bytes: Uint8Array;
    }[] = [];
    const edited: string[] = [];
    for (const file of files) {
      const made = await placedBytes(
        context,
        { ...record, macros },
        request.script,
        file.source,
        to,
        documentMacros,
      );
      if ("refused" in made) return { _tag: "refused", message: made.refused, edited: [] };
      macros = made.macros;
      const current = await context.files.read(file.path);
      if (current !== null && sha256(current) !== file.sha256) edited.push(file.path);
      plan.push({ file, current, bytes: made.bytes });
    }
    if (edited.length > 0 && !request.replaceEdited)
      return {
        _tag: "refused",
        message: `${edited.join(", ")} ${edited.length === 1 ? "was" : "were"} edited after Scient placed ${edited.length === 1 ? "it" : "them"}.`,
        edited,
      };

    const updateId = `u${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    const copies = undoFolder(context.layout, context.projectId, updateId);
    await NodeFSP.mkdir(copies, { recursive: true });
    const undoFiles: UpdateRecord["files"][number][] = [];
    for (const [index, step] of plan.entries()) {
      let before: { sha256: string; copy: string } | null = null;
      if (step.current !== null) {
        const copy = String(index);
        await NodeFSP.writeFile(NodePath.join(copies, copy), step.current);
        before = { sha256: sha256(step.current), copy };
      }
      undoFiles.push({
        path: step.file.path,
        before,
        after: sha256(step.bytes),
        previous: step.file,
      });
    }

    const written: number[] = [];
    let failure: unknown = null;
    for (const [index, step] of plan.entries()) {
      try {
        const expected = step.current === null ? null : sha256(step.current);
        if (await context.files.write(step.file.path, step.bytes, expected)) {
          written.push(index);
          continue;
        }
        failure = new PlacementRefusal({
          message: `${step.file.path} changed while Scient was updating it.`,
        });
      } catch (cause) {
        failure = cause;
      }
      break;
    }
    if (failure !== null) {
      // Put back what was written, so the paper never mixes two runs.
      for (const index of written.toReversed()) {
        const step = plan[index]!;
        if (step.current !== null)
          await context.files
            .write(step.file.path, step.current, sha256(step.bytes))
            .catch(() => false);
      }
      await NodeFSP.rm(copies, { recursive: true, force: true }).catch(() => undefined);
      const message = isPlacementRefusal(failure)
        ? failure.message
        : `Nothing was changed: a file could not be written${failure instanceof Error ? ` (${failure.message})` : ""}. Close any program that has it open, then try again.`;
      return { _tag: "refused", message, edited: [] };
    }

    const replaced = new Map(
      plan.map((step) => [
        step.file.path,
        { ...step.file, revision: to.revision, sha256: sha256(step.bytes), placedAt: request.now },
      ]),
    );
    const stale = record.updates.filter(
      (update) => update.script === request.script && update.root === root,
    );
    await writeRecord(context.layout, context.projectId, {
      ...record,
      macros,
      files: record.files.map((file) => replaced.get(file.path) ?? file),
      updates: [
        ...record.updates.filter((update) => !stale.includes(update)),
        { id: updateId, script: request.script, root, files: undoFiles },
      ],
    });
    for (const update of stale)
      await NodeFSP.rm(undoFolder(context.layout, context.projectId, update.id), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    return { _tag: "changed", files: plan.map((step) => step.file.path) };
  });
}

/** Puts back what the last Update files replaced, if nothing changed those files since. */
export function undoPlacedFilesUpdate(
  context: PlacementContext,
  request: { readonly documentPath: string; readonly script: string },
): Promise<ComputeResultsFilesChangeResult> {
  return serialized(context.projectId, async () => {
    const root = documentRoot(request.documentPath);
    const record = await readRecord(context.layout, context.projectId);
    const update = record.updates.find(
      (candidate) => candidate.script === request.script && candidate.root === root,
    );
    if (update === undefined)
      return { _tag: "refused", message: "There is no update to undo.", edited: [] };
    const copies = undoFolder(context.layout, context.projectId, update.id);
    const changed: string[] = [];
    const current = new Map<string, Uint8Array>();
    for (const file of update.files) {
      const bytes = await context.files.read(file.path);
      if (bytes === null || sha256(bytes) !== file.after) changed.push(file.path);
      else current.set(file.path, bytes);
    }
    if (changed.length > 0)
      return {
        _tag: "refused",
        message: `${changed.join(", ")} changed after the update, so it cannot be undone.`,
        edited: changed,
      };
    const restored: (typeof update.files)[number][] = [];
    let failure: unknown = null;
    for (const file of update.files) {
      // A file the update created from nothing stays; the previous run never had it on disk.
      if (file.before === null) continue;
      try {
        const bytes = new Uint8Array(
          await NodeFSP.readFile(NodePath.join(copies, file.before.copy)),
        );
        if (await context.files.write(file.path, bytes, file.after)) {
          restored.push(file);
          continue;
        }
        failure = new PlacementRefusal({
          message: `${file.path} changed while Scient was undoing the update.`,
        });
      } catch (cause) {
        failure = cause;
      }
      break;
    }
    if (failure !== null) {
      // Put the newer bytes back on what was already restored, so the paper stays on one run.
      for (const file of restored.toReversed())
        await context.files
          .write(file.path, current.get(file.path)!, file.before!.sha256)
          .catch(() => false);
      return {
        _tag: "refused",
        message: isPlacementRefusal(failure)
          ? failure.message
          : "Nothing was changed: a file could not be written. Close any program that has it open, then try again.",
        edited: [],
      };
    }
    const previous = new Map(update.files.map((file) => [file.path, file.previous]));
    await writeRecord(context.layout, context.projectId, {
      ...record,
      files: record.files.map((file) => previous.get(file.path) ?? file),
      updates: record.updates.filter((candidate) => candidate !== update),
    });
    await NodeFSP.rm(copies, { recursive: true, force: true }).catch(() => undefined);
    return { _tag: "changed", files: restored.map((file) => file.path) };
  });
}
