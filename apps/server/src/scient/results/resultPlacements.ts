// @effect-diagnostics nodeBuiltinImport:off -- the placement record and Undo copies are files under Scient's compute state.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ComputeResultFileDigest,
  ComputeResultFileState,
  ComputeResultPlacedFile,
  ComputeResultPlacedScript,
  ComputeResultRevision,
  ComputeResultsFilesChangeResult,
  ComputeResultsPlaceLatexResult,
  ComputeResultsPlacementsResult,
} from "@t3tools/contracts";
import {
  readResultValues,
  resultCaption,
  resultSourceChanged,
} from "@t3tools/shared/computeResults";
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
import { readLatexDocumentSources } from "../latex/LatexProjectIndex.ts";
import type { ResultsLayout, ResultsReader } from "./resultRevisions.ts";

/**
 * LaTeX papers take results as plain files under `results/<script>/` beside the root document,
 * recorded with their run and bytes. Update and Undo are journaled before any file changes, so an
 * interrupted one is finished, or offered for Undo, the next time the record is read.
 */

/** Project files as the placement code sees them; the server passes its guarded workspace writer. */
export interface ProjectFiles {
  /**
   * A regular file inside the project, or null when nothing is there. Throws for a path reached
   * through a link, which Scient neither reads nor changes, so a link never counts as absence.
   */
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
  /** Removes the file when it still holds those bytes; false when it changed. */
  readonly remove: (path: string, expectedSha256: string) => Promise<boolean>;
}

type PlacementSource =
  | { readonly kind: "values" }
  | { readonly kind: "table"; readonly output: string }
  /** `wholeFloat`: a `.tex` the script wrote that is already a `table` float. */
  | { readonly kind: "copy"; readonly output: string; readonly wholeFloat?: boolean };

const sourceKey = (source: PlacementSource) =>
  source.kind === "values" ? "values" : `${source.kind}:${source.output}`;

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

/** One Update files, from its start through a possible Undo. */
interface ChangeRecord {
  readonly id: string;
  readonly script: string;
  readonly root: string;
  /**
   * `updating` and `undoing` are written before files change, so finding one means the change
   * stopped part way; `updated` is a finished Update that Undo can reverse.
   */
  readonly state: "updating" | "updated" | "undoing";
  readonly files: ReadonlyArray<{
    readonly path: string;
    /** What the file held before, kept under the Undo folder; null when it was missing. */
    readonly before: { readonly sha256: string; readonly copy: string } | null;
    readonly after: string;
  }>;
  /** The script's placements for this root before and after the Update. */
  readonly placementsBefore: ReadonlyArray<PlacedFileRecord>;
  readonly placementsAfter: ReadonlyArray<PlacedFileRecord>;
  readonly macrosAfter: ReadonlyArray<MacroRecord>;
}

interface PlacementRecord {
  readonly version: 1;
  /** Script path → its folder name under `results/`. */
  readonly folders: Readonly<Record<string, string>>;
  readonly macros: ReadonlyArray<MacroRecord>;
  readonly files: ReadonlyArray<PlacedFileRecord>;
  readonly changes: ReadonlyArray<ChangeRecord>;
}

const EMPTY_RECORD: PlacementRecord = {
  version: 1,
  folders: {},
  macros: [],
  files: [],
  changes: [],
};

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const recordFolder = (layout: ResultsLayout, projectId: string) =>
  NodePath.join(layout.computeDir, "results", projectId);
const recordPath = (layout: ResultsLayout, projectId: string) =>
  NodePath.join(recordFolder(layout, projectId), "placements.json");
const undoFolder = (layout: ResultsLayout, projectId: string, changeId: string) =>
  NodePath.join(recordFolder(layout, projectId), "placement-undo", changeId);

async function readRecord(layout: ResultsLayout, projectId: string): Promise<PlacementRecord> {
  const text = await NodeFSP.readFile(recordPath(layout, projectId), "utf8").catch(() => null);
  if (text === null) return EMPTY_RECORD;
  const parsed = JSON.parse(text) as Partial<PlacementRecord>;
  if (parsed.version !== 1) return EMPTY_RECORD;
  return {
    version: 1,
    folders: parsed.folders ?? {},
    macros: parsed.macros ?? [],
    files: parsed.files ?? [],
    changes: parsed.changes ?? [],
  };
}

async function writeRecord(layout: ResultsLayout, projectId: string, record: PlacementRecord) {
  const target = recordPath(layout, projectId);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
  await NodeFSP.rename(temporary, target);
}

/** One change at a time per project, so two requests never interleave their record writes. */
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

/**
 * A file name TeX reads as it is: letters, digits, `.`, `-` and `_` only, since `%`, `#`, spaces
 * and the like would end or change an `\input` or `\includegraphics` argument.
 */
function texSafeFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const stem =
    (dot > 0 ? name.slice(0, dot) : name)
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "result";
  return /^[a-z0-9]+$/u.test(extension) ? `${stem}.${extension}` : stem;
}

const withSuffix = (name: string, index: number) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${index}${name.slice(dot)}` : `${name}-${index}`;
};

export interface PlacementContext {
  readonly layout: ResultsLayout;
  readonly projectId: string;
  readonly reader: ResultsReader;
  readonly files: ProjectFiles;
  /** The project folder, which a paper's includes are resolved inside. */
  readonly projectRoot: string;
}

async function revisionById(context: PlacementContext, id: string) {
  return (await context.reader.revisions()).find((candidate) => candidate.revision === id);
}

async function latestFor(context: PlacementContext, script: string) {
  return context.reader.latestPublished(script);
}

async function diskSha(context: PlacementContext, path: string): Promise<string | null> {
  const bytes = await context.files.read(path);
  return bytes === null ? null : sha256(bytes);
}

/** Every value a revision's values files hold. */
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

const isWholeFloat = (bytes: Uint8Array) => /\\begin\s*\{table\*?\}/u.test(decode(bytes));

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
  if (source.kind === "copy") {
    // A float must stay a float, and a bare tabular stay bare, or the paper's wrapper breaks.
    if (source.wholeFloat !== undefined && isWholeFloat(bytes) !== source.wholeFloat)
      return {
        refused: `${source.output} changed between a whole table float and a bare tabular. Insert it again instead of updating.`,
      };
    return { bytes, macros: record.macros };
  }
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
  const taken = new Set(Object.values(record.folders).map((folder) => folder.toLowerCase()));
  const base = outputSlug(script);
  let name = base;
  for (let index = 2; taken.has(name.toLowerCase()); index += 1) name = `${base}-${index}`;
  return name;
}

const placementsOf = (record: PlacementRecord, script: string, root: string) =>
  record.files.filter((file) => file.script === script && file.root === root);

const changeOf = (record: PlacementRecord, script: string, root: string) =>
  record.changes.find((change) => change.script === script && change.root === root);

const samePlacements = (
  left: ReadonlyArray<PlacedFileRecord>,
  right: ReadonlyArray<PlacedFileRecord>,
) => {
  const key = (file: PlacedFileRecord) => `${file.path}\u0000${file.revision}\u0000${file.sha256}`;
  const keys = new Set(left.map(key));
  return left.length === right.length && right.every((file) => keys.has(key(file)));
};

/** The record with a script's placements for one root replaced. */
const withPlacements = (
  record: PlacementRecord,
  script: string,
  root: string,
  placements: ReadonlyArray<PlacedFileRecord>,
): PlacementRecord => ({
  ...record,
  files: [
    ...record.files.filter((file) => file.script !== script || file.root !== root),
    ...placements,
  ],
});

const dropChange = (record: PlacementRecord, change: ChangeRecord): PlacementRecord => ({
  ...record,
  changes: record.changes.filter((candidate) => candidate.id !== change.id),
});

const removeCopies = (context: PlacementContext, change: ChangeRecord) =>
  NodeFSP.rm(undoFolder(context.layout, context.projectId, change.id), {
    recursive: true,
    force: true,
  }).catch(() => undefined);

/** Where each file of a change stands on disk: before it, after it, or neither. */
async function changePositions(context: PlacementContext, change: ChangeRecord) {
  const positions: Array<"before" | "after" | "both" | "other"> = [];
  for (const file of change.files) {
    const current = await diskSha(context, file.path).catch(() => undefined);
    const isAfter = current === file.after;
    const isBefore =
      current !== undefined &&
      (file.before === null ? current === null : current === file.before.sha256);
    // An update that left a file's bytes as they were counts on both sides.
    positions.push(
      isAfter && isBefore ? "both" : isAfter ? "after" : isBefore ? "before" : "other",
    );
  }
  return positions;
}

const allOn = (
  positions: ReadonlyArray<"before" | "after" | "both" | "other">,
  side: "before" | "after",
) => positions.every((position) => position === side || position === "both");

/**
 * Finishes what an interrupted Update or Undo left: when every file reached one side, the record
 * follows the files. A mix stays recorded, and Undo update puts the earlier files back.
 */
async function reconcile(context: PlacementContext, record: PlacementRecord) {
  let next = record;
  const retired: ChangeRecord[] = [];
  for (const change of record.changes) {
    if (change.state === "updated") continue;
    const positions = await changePositions(context, change);
    const allAfter = allOn(positions, "after");
    const allBefore = allOn(positions, "before");
    if (change.state === "updating" && allAfter)
      next = {
        ...withPlacements(next, change.script, change.root, change.placementsAfter),
        macros: change.macrosAfter,
        changes: next.changes.map((candidate) =>
          candidate.id === change.id ? { ...change, state: "updated" as const } : candidate,
        ),
      };
    else if (change.state === "updating" && allBefore) {
      next = dropChange(next, change);
      retired.push(change);
    } else if (change.state === "undoing" && allBefore) {
      next = dropChange(
        withPlacements(next, change.script, change.root, change.placementsBefore),
        change,
      );
      retired.push(change);
    } else if (change.state === "undoing" && allAfter)
      next = {
        ...next,
        changes: next.changes.map((candidate) =>
          candidate.id === change.id ? { ...change, state: "updated" as const } : candidate,
        ),
      };
  }
  if (next !== record) await writeRecord(context.layout, context.projectId, next);
  // Copies go only once the record no longer needs them.
  for (const change of retired) await removeCopies(context, change);
  return next;
}

const interrupted = (change: ChangeRecord | undefined) =>
  change !== undefined && change.state !== "updated";

const INTERRUPTED_MESSAGE =
  "The last update of these files stopped part way. Undo update puts the earlier files back.";

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
    let record = await reconcile(context, await readRecord(context.layout, context.projectId));
    if (interrupted(changeOf(record, script, root)))
      throw new PlacementRefusal({ message: INTERRUPTED_MESSAGE });
    const placedForScript = placementsOf(record, script, root);
    if (placedForScript.some((file) => file.revision !== revision.revision))
      throw new PlacementRefusal({
        message: `Results from ${script} in this paper come from another run. Update files first, so they all come from one run.`,
      });
    if (output.kind === "figure" && /\.svg$/iu.test(output.name))
      throw new PlacementRefusal({
        message: `LaTeX cannot include ${output.name} as it is. Have the script save the figure as PDF or PNG too.`,
      });
    let source: PlacementSource;
    if (output.kind === "values") source = { kind: "values" };
    else if (output.kind === "table") source = { kind: "table", output: output.name };
    else if (output.kind === "figure" || output.kind === "latex")
      source = { kind: "copy", output: output.name };
    else throw new PlacementRefusal({ message: `${output.name} is not a value, table or figure.` });
    if (source.kind === "values" && request.pointer === null)
      throw new PlacementRefusal({ message: "Choose a value from the values file." });
    const documentMacros = definedMacros(request.documentText);
    const made = await placedBytes(context, record, script, source, revision, documentMacros);
    if ("refused" in made) throw new PlacementRefusal({ message: made.refused });
    if (source.kind === "values") {
      // A name given for another paper may be defined differently in this one; that one would win.
      const included = request.documentText.includes(`% Made by Scient from ${script}, run`);
      const clash = made.macros.find(
        (macro) =>
          macro.script === script &&
          macro.output === output.name &&
          macro.pointer === request.pointer &&
          !included &&
          documentMacros.has(macro.macro),
      );
      if (clash !== undefined)
        throw new PlacementRefusal({
          message: `This paper already defines \\${clash.macro}. Rename or remove that definition, then insert again.`,
        });
    }
    if (source.kind === "copy" && output.kind === "latex")
      source = { ...source, wholeFloat: isWholeFloat(made.bytes) };

    const folder = scriptFolder(record, script);
    const existing = placedForScript.find((file) => sourceKey(file.source) === sourceKey(source));
    let path: string;
    if (existing !== undefined) {
      path = existing.path;
      // Placed earlier from this run: a missing copy is restored, anything else stays as it is.
      if ((await context.files.read(path)) === null) {
        if (!(await context.files.write(path, made.bytes, null)))
          throw new PlacementRefusal({
            message: `${path} appeared while Scient was writing it. Try again.`,
          });
        record = withPlacements(record, script, root, [
          ...placedForScript.filter((file) => file !== existing),
          { ...existing, sha256: sha256(made.bytes), placedAt: request.now },
        ]);
      }
    } else {
      // Each output gets its own file: two outputs never share a destination, in any letter case.
      const base = texSafeFileName(
        source.kind === "values"
          ? "values.tex"
          : source.kind === "table"
            ? `${outputSlug(output.name)}.tex`
            : (output.name.split("/").at(-1) ?? output.name),
      );
      const taken = new Set(
        record.files.filter((file) => file.root === root).map((file) => file.path.toLowerCase()),
      );
      let candidate = inRoot(root, `results/${folder}/${base}`);
      for (let index = 2; ; index += 1) {
        if (index > 100)
          throw new PlacementRefusal({ message: "Too many files already use this result's name." });
        if (!taken.has(candidate.toLowerCase())) {
          // A link at this name counts as taken.
          const onDisk = await context.files.read(candidate).catch(() => undefined);
          // A file Scient did not place is never overwritten; an identical one is adopted.
          if (onDisk === null) {
            if (await context.files.write(candidate, made.bytes, null)) break;
          } else if (onDisk !== undefined && sha256(onDisk) === sha256(made.bytes)) break;
        }
        candidate = inRoot(root, `results/${folder}/${withSuffix(base, index)}`);
      }
      path = candidate;
      record = withPlacements(record, script, root, [
        ...placedForScript,
        {
          path,
          root,
          script,
          revision: revision.revision,
          source,
          sha256: sha256(made.bytes),
          placedAt: request.now,
        },
      ]);
    }
    record = { ...record, folders: { ...record.folders, [script]: folder }, macros: made.macros };
    await writeRecord(context.layout, context.projectId, record);

    const relativePath = root === "" ? path : NodePath.posix.relative(root, path);
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
        macro: {
          name: macro.macro,
          definition: escapeLatexText(value?.value ?? ""),
          // The values file's first line: seeing it in the setup means the file is included.
          includedMarker: `% Made by Scient from ${script}, run`,
        },
        preambleInput: `\\input{${relativePath}}`,
        packages: [],
        files: [path],
      };
    }
    // From the placed file, so two outputs with one base name get two labels.
    const label = outputSlug(path);
    const caption = escapeLatexText(resultCaption(output.name));
    if (output.kind === "figure")
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
    const whole = source.kind === "copy" && source.wholeFloat === true;
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
  // A file replaced by a link is not the placed file.
  const current = await diskSha(context, file.path).catch(() => "");
  if (current === null) return "missing";
  if (current !== file.sha256) return "edited";
  return outOfDate ? "out-of-date" : "current";
}

const macroUsed = (text: string, macro: string) =>
  new RegExp(`\\\\${macro}(?![A-Za-z])`, "u").test(text);

interface PaperDocument {
  readonly documentPath: string;
  readonly documentText: string;
  /** The root's text was cut short when read, so part of it went unchecked. */
  readonly documentTruncated?: boolean | undefined;
}

/** The TeX a paper and the files it includes build from, and whether all of it was read. */
async function paperSource(
  context: PlacementContext,
  record: PlacementRecord,
  document: PaperDocument,
): Promise<{ readonly text: string; readonly complete: boolean }> {
  const scan = await readLatexDocumentSources({
    workspaceRoot: context.projectRoot,
    rootRelativePath: document.documentPath,
    rootContents: document.documentText,
  });
  // A placed file defines the macros; once edited, it is the user's and may use them.
  const generated = new Map(record.files.map((file) => [file.path, file.sha256]));
  return {
    text: scan.sources
      .filter((source) => generated.get(source.relativePath) !== source.sha256)
      .map((source) => source.visibleSource)
      .join("\n"),
    complete: scan.incompleteReasons.size === 0 && document.documentTruncated !== true,
  };
}

/** Why the newest run cannot replace a script's placed files, or null when it can. */
async function updateRefusal(
  context: PlacementContext,
  record: PlacementRecord,
  files: ReadonlyArray<PlacedFileRecord>,
  from: ComputeResultRevision,
  to: ComputeResultRevision,
  document: PaperDocument,
): Promise<string | null> {
  let paper: { readonly text: string; readonly complete: boolean } | undefined;
  for (const file of files) {
    const source = file.source;
    if (source.kind === "values") {
      const after = new Set(
        (await revisionValues(context, to)).map((value) => `${value.output}#${value.pointer}`),
      );
      // A value the newer run dropped matters only when the paper uses it.
      const gone: string[] = [];
      const unchecked: string[] = [];
      for (const value of await revisionValues(context, from)) {
        if (after.has(`${value.output}#${value.pointer}`)) continue;
        const macro = record.macros.find(
          (candidate) =>
            candidate.script === file.script &&
            candidate.output === value.output &&
            candidate.pointer === value.pointer,
        );
        if (macro === undefined) continue;
        paper ??= await paperSource(context, record, document);
        const name = `${value.pointer.slice(1) || value.output} (\\${macro.macro})`;
        if (macroUsed(paper.text, macro.macro)) gone.push(name);
        else if (!paper.complete) unchecked.push(name);
      }
      if (gone.length > 0) return `The newer run no longer produces ${gone.join(", ")}.`;
      if (unchecked.length > 0)
        return `The newer run no longer produces ${unchecked.join(", ")}, and Scient could not read all of this paper's files to check that nothing uses ${unchecked.length === 1 ? "it" : "them"}.`;
      continue;
    }
    const output = to.outputs.find((candidate) => candidate.name === source.output);
    if (output === undefined || output.pruned === true)
      return `The newer run no longer writes ${source.output}.`;
    const made = await placedBytes(context, record, file.script, source, to, new Set());
    if ("refused" in made) return made.refused;
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

/** Whether a finished Update can still be reversed exactly. */
async function undoable(
  context: PlacementContext,
  record: PlacementRecord,
  change: ChangeRecord,
): Promise<boolean> {
  if (change.state !== "updated") return true;
  // Results placed or changed after the update would be left on its run, so it no longer reverses.
  if (!samePlacements(placementsOf(record, change.script, change.root), change.placementsAfter))
    return false;
  return (await changePositions(context, change)).every((position) => position === "after");
}

/** Placed files under a paper's root, grouped by script, with what Update files would do. */
export function placementStatus(
  context: PlacementContext,
  request: PaperDocument & {
    readonly build: {
      readonly finishedAt: string;
      readonly digests: Readonly<Record<string, string>>;
    } | null;
  },
): Promise<ComputeResultsPlacementsResult> {
  return serialized(context.projectId, async () => {
    const root = documentRoot(request.documentPath);
    const record = await reconcile(context, await readRecord(context.layout, context.projectId));
    // An empty dependency record says nothing about what the PDF read.
    const build =
      request.build !== null && Object.keys(request.build.digests).length > 0
        ? request.build
        : null;
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
      const placed: ComputeResultPlacedFile[] = [];
      for (const file of files) {
        const state = await fileState(context, file, resultSourceChanged(summary));
        // The build's record covers .tex inputs, not figures.
        const usedByBuild =
          build === null || !/\.tex$/iu.test(file.path)
            ? null
            : build.digests[file.path] !== undefined;
        const built = build?.digests[file.path];
        placed.push({
          path: file.path,
          ...(state === "missing" || state === "edited" ? {} : { sha256: file.sha256 }),
          state,
          usedByBuild,
          differsFromBuild:
            build !== null &&
            usedByBuild !== false &&
            state !== "missing" &&
            ((built !== undefined && built !== `sha256:${file.sha256}`) ||
              file.placedAt > build.finishedAt),
        });
      }
      const change = changeOf(record, script, root);
      const updateBlocked =
        newer === null
          ? null
          : await updateRefusal(context, record, files, revision, newer, request);
      scripts.push({
        summary,
        newer: newer === null ? null : await context.reader.summary(newer),
        updateBlocked,
        changes:
          newer === null || updateBlocked !== null
            ? []
            : await updateChanges(context, record, files, revision, newer),
        files: placed,
        canUndo: change !== undefined && (await undoable(context, record, change)),
        interrupted: interrupted(change),
      });
    }
    return { scripts, coverage: build === null ? "placed" : "build" };
  });
}

const refused = (
  message: string,
  edited: ReadonlyArray<ComputeResultFileDigest> = [],
): ComputeResultsFilesChangeResult => ({ _tag: "refused", message, edited });

/**
 * Replaces every file a script placed for a paper with the run the user was shown, as one change:
 * all are written, or none stay written. The previous bytes, hand edits included, are kept for
 * Undo. Asked for the files' own run, it restores the missing ones.
 */
export function updatePlacedFiles(
  context: PlacementContext,
  request: PaperDocument & {
    readonly script: string;
    readonly toRevision: string;
    readonly replaceEdited: ReadonlyArray<ComputeResultFileDigest>;
    readonly now: string;
  },
): Promise<ComputeResultsFilesChangeResult> {
  return serialized(context.projectId, async () => {
    const root = documentRoot(request.documentPath);
    let record = await reconcile(context, await readRecord(context.layout, context.projectId));
    if (interrupted(changeOf(record, request.script, root))) return refused(INTERRUPTED_MESSAGE);
    const files = placementsOf(record, request.script, root);
    if (files.length === 0) return refused(`No results from ${request.script} are in this paper.`);
    const from = await revisionById(context, files[0]!.revision);
    const to = await latestFor(context, request.script);
    if (from === undefined || to === undefined)
      return refused("This run is not recorded on this computer.");

    if (request.toRevision === from.revision) {
      const restored: string[] = [];
      for (const file of files) {
        if ((await context.files.read(file.path)) !== null) continue;
        const made = await placedBytes(
          context,
          record,
          request.script,
          file.source,
          from,
          new Set(),
        );
        if ("refused" in made) return refused(made.refused);
        if (sha256(made.bytes) !== file.sha256)
          return refused(`${file.path} cannot be made again exactly. Update to a newer run.`);
        if (await context.files.write(file.path, made.bytes, null)) restored.push(file.path);
      }
      return restored.length === 0
        ? refused("No placed file is missing.")
        : { _tag: "changed", files: restored };
    }
    if (to.revision !== request.toRevision)
      return refused(`A newer run of ${request.script} finished. Look at what it changes first.`);
    const refusal = await updateRefusal(context, record, files, from, to, request);
    if (refusal !== null) return refused(refusal);

    const documentMacros = definedMacros(request.documentText);
    let macros = record.macros;
    const plan: { file: PlacedFileRecord; current: Uint8Array | null; bytes: Uint8Array }[] = [];
    const unconfirmed: ComputeResultFileDigest[] = [];
    for (const file of files) {
      const made = await placedBytes(
        context,
        { ...record, macros },
        request.script,
        file.source,
        to,
        documentMacros,
      );
      if ("refused" in made) return refused(made.refused);
      macros = made.macros;
      const current = await context.files.read(file.path);
      const currentSha = current === null ? null : sha256(current);
      // An edit is replaced only as the user saw it when agreeing; a later edit asks again.
      if (
        currentSha !== null &&
        currentSha !== file.sha256 &&
        !request.replaceEdited.some(
          (confirmed) => confirmed.path === file.path && confirmed.sha256 === currentSha,
        )
      )
        unconfirmed.push({ path: file.path, sha256: currentSha });
      plan.push({ file, current, bytes: made.bytes });
    }
    if (unconfirmed.length > 0)
      return refused(
        `${unconfirmed.map((file) => file.path).join(", ")} ${unconfirmed.length === 1 ? "was" : "were"} edited after Scient placed ${unconfirmed.length === 1 ? "it" : "them"}.`,
        unconfirmed,
      );

    const changeId = `u${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    const copies = undoFolder(context.layout, context.projectId, changeId);
    await NodeFSP.mkdir(copies, { recursive: true });
    const changeFiles: ChangeRecord["files"][number][] = [];
    for (const [index, step] of plan.entries()) {
      let before: { sha256: string; copy: string } | null = null;
      if (step.current !== null) {
        const copy = String(index);
        await NodeFSP.writeFile(NodePath.join(copies, copy), step.current);
        before = { sha256: sha256(step.current), copy };
      }
      changeFiles.push({ path: step.file.path, before, after: sha256(step.bytes) });
    }
    const change: ChangeRecord = {
      id: changeId,
      script: request.script,
      root,
      state: "updating",
      files: changeFiles,
      placementsBefore: files,
      placementsAfter: plan.map((step) => ({
        ...step.file,
        revision: to.revision,
        sha256: sha256(step.bytes),
        placedAt: request.now,
      })),
      macrosAfter: macros,
    };
    // Recorded before any file changes, so an interruption is found and finished or undone.
    const finished = record.changes.filter(
      (candidate) => candidate.script === request.script && candidate.root === root,
    );
    record = {
      ...record,
      changes: [...record.changes.filter((c) => !finished.includes(c)), change],
    };
    await writeRecord(context.layout, context.projectId, record);
    for (const old of finished) await removeCopies(context, old);

    const written: number[] = [];
    let attempted = 0;
    let failure: unknown = null;
    for (const [index, step] of plan.entries()) {
      attempted = index + 1;
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
      const stuck: string[] = [];
      for (const index of written.toReversed()) {
        const step = plan[index]!;
        const after = sha256(step.bytes);
        const back = await (
          step.current === null
            ? context.files.remove(step.file.path, after)
            : context.files.write(step.file.path, step.current, after)
        ).catch(() => false);
        if (!back) stuck.push(step.file.path);
      }
      const reason = isPlacementRefusal(failure)
        ? failure.message
        : `A file could not be written${failure instanceof Error ? ` (${failure.message})` : ""}. Close any program that has it open, then try again.`;
      // A failed write can still have changed its file, so every file tried is checked again.
      const positions = await changePositions(context, {
        ...change,
        files: change.files.slice(0, attempted),
      });
      for (const [index, position] of positions.entries())
        if (position === "other" || position === "after")
          if (!stuck.includes(change.files[index]!.path)) stuck.push(change.files[index]!.path);
      if (stuck.length > 0)
        // The journal stays, so the status offers Undo update for what could not be put back.
        return refused(
          `${reason} ${stuck.join(", ")} could not be put back; Undo update restores ${stuck.length === 1 ? "it" : "them"}.`,
        );
      await writeRecord(context.layout, context.projectId, dropChange(record, change));
      await removeCopies(context, change);
      return refused(`Nothing was changed. ${reason}`);
    }

    await writeRecord(context.layout, context.projectId, {
      ...withPlacements(record, request.script, root, change.placementsAfter),
      macros,
      changes: record.changes.map((candidate) =>
        candidate.id === change.id ? { ...change, state: "updated" as const } : candidate,
      ),
    });
    return { _tag: "changed", files: plan.map((step) => step.file.path) };
  });
}

/**
 * Puts back what the last Update files replaced, as long as nothing changed those files or the
 * script's placements since; after an interrupted change, it restores whatever that change wrote.
 */
export function undoPlacedFilesUpdate(
  context: PlacementContext,
  request: { readonly documentPath: string; readonly script: string },
): Promise<ComputeResultsFilesChangeResult> {
  return serialized(context.projectId, async () => {
    const root = documentRoot(request.documentPath);
    let record = await reconcile(context, await readRecord(context.layout, context.projectId));
    const change = changeOf(record, request.script, root);
    if (change === undefined) return refused("There is no update to undo.");
    if (
      change.state === "updated" &&
      !samePlacements(placementsOf(record, request.script, root), change.placementsAfter)
    )
      return refused(
        "Results were added or changed after the update, so undoing it would mix two runs.",
      );
    const positions = await changePositions(context, change);
    const changed = change.files.filter((_, index) => positions[index] === "other");
    if (changed.length > 0)
      return refused(
        `${changed.map((file) => file.path).join(", ")} changed after the update, so it cannot be undone.`,
      );

    const undoing: ChangeRecord = { ...change, state: "undoing" };
    record = {
      ...record,
      changes: record.changes.map((candidate) =>
        candidate.id === change.id ? undoing : candidate,
      ),
    };
    await writeRecord(context.layout, context.projectId, record);
    const copies = undoFolder(context.layout, context.projectId, change.id);
    const restored: string[] = [];
    for (const [index, file] of change.files.entries()) {
      if (positions[index] === "before" || positions[index] === "both") continue;
      try {
        const back =
          file.before === null
            ? await context.files.remove(file.path, file.after)
            : await context.files.write(
                file.path,
                new Uint8Array(await NodeFSP.readFile(NodePath.join(copies, file.before.copy))),
                file.after,
              );
        if (!back)
          return refused(
            `${file.path} changed while Scient was undoing the update. Undo update again to finish.`,
          );
      } catch {
        return refused(
          `${file.path} could not be restored. Close any program that has it open, then Undo update again.`,
        );
      }
      restored.push(file.path);
    }
    // Retired only once every file is back as it was.
    if (!allOn(await changePositions(context, change), "before"))
      return refused("Some files did not return to their earlier version. Undo update again.");
    await writeRecord(
      context.layout,
      context.projectId,
      dropChange(withPlacements(record, request.script, root, change.placementsBefore), undoing),
    );
    await removeCopies(context, change);
    return { _tag: "changed", files: restored };
  });
}
