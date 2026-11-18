// @effect-diagnostics nodeBuiltinImport:off -- placements are files on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  placeLatexResult,
  placementStatus,
  undoPlacedFilesUpdate,
  updatePlacedFiles,
  type ProjectFiles,
} from "./resultPlacements.ts";
import { makeResultsReader, publishScriptRun } from "./resultRevisions.ts";

const folders: string[] = [];
let runs = 0;
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => NodeFSP.rm(folder, { recursive: true })));
});

const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const at = (second: number) => `2026-11-18T08:00:${String(second).padStart(2, "0")}.000Z`;

/**
 * The project's files as the server writer treats them: a write only lands on what was expected.
 * `failures` counts down writes to a path, then throws, as a file another program holds open does.
 */
function diskFiles(root: string, failures: Readonly<Record<string, number>> = {}): ProjectFiles {
  const left = new Map(Object.entries(failures));
  return {
    read: async (path) => {
      const bytes = await NodeFSP.readFile(NodePath.join(root, path)).catch(() => null);
      return bytes === null ? null : new Uint8Array(bytes);
    },
    write: async (path, bytes, expected) => {
      const skip = left.get(path);
      if (skip !== undefined) {
        if (skip === 0) throw new Error("EBUSY: file is open");
        left.set(path, skip - 1);
      }
      const target = NodePath.join(root, path);
      const current = await NodeFSP.readFile(target).catch(() => null);
      if (expected === null ? current !== null : current === null || sha256(current) !== expected)
        return false;
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(target, bytes);
      return true;
    },
    remove: async (path, expected) => {
      const target = NodePath.join(root, path);
      const current = await NodeFSP.readFile(target).catch(() => null);
      if (current === null || sha256(current) !== expected) return false;
      await NodeFSP.rm(target);
      return true;
    },
  };
}

async function setup() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "linked-latex-")),
  );
  folders.push(base);
  const root = NodePath.join(base, "project");
  const layout = { computeDir: NodePath.join(base, "compute") };
  await NodeFSP.mkdir(NodePath.join(root, "paper"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "analysis.py"), "print('fit')\n");
  const publish = async (outputs: Record<string, string>) => {
    runs += 1;
    const stagingFolder = NodePath.join(layout.computeDir, "staging", `run-${runs}`);
    for (const [name, contents] of Object.entries(outputs)) {
      const target = NodePath.join(stagingFolder, name);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(target, contents);
    }
    const outcome = await publishScriptRun(layout, {
      projectId: "p",
      root,
      stagingFolder,
      succeeded: true,
      scriptPath: "analysis.py",
      language: "Python",
      code: await NodeFSP.readFile(NodePath.join(root, "analysis.py"), "utf8"),
      sessionId: "s",
      executionId: `run-${runs}`,
      startedAt: null,
      finishedAt: at(runs % 50),
      threadId: undefined,
      runtime: { executable: null, version: null, fingerprint: null },
      reads: { files: [], truncated: false },
    });
    if (outcome._tag !== "published") throw new Error(outcome.message);
    return outcome.revision.revision;
  };
  const context = (files: ProjectFiles = diskFiles(root)) => ({
    layout,
    projectId: "p",
    reader: makeResultsReader(layout, "p", root),
    files,
  });
  const read = (path: string) => NodeFSP.readFile(NodePath.join(root, path), "utf8");
  const status = (documentText = "") =>
    placementStatus(context(), { documentPath: "main.tex", documentText, build: null });
  return { root, publish, context, read, status };
}

const FIRST = {
  "values.json": '{"cohort": {"n": 1229}, "hr": "0.73"}',
  "table1.csv": "Arm,n\nTreatment,600\nControl,629\n",
  "km.pdf": "%PDF-1",
};
const SECOND = {
  "values.json": '{"cohort": {"n": 1178}, "hr": "0.75"}',
  "table1.csv": "Arm,n\nTreatment,570\nControl,608\n",
  "km.pdf": "%PDF-2",
};
const PAPER = "\\resultAnalysisHr and \\resultAnalysisCohortN";

describe("placing results for a LaTeX paper", () => {
  it("writes plain LaTeX files beside the root document and returns what to insert", async () => {
    const place = await setup();
    const revision = await place.publish(FIRST);
    const request = { documentPath: "paper/main.tex", documentText: "", revision, now: at(50) };

    const value = await placeLatexResult(place.context(), {
      ...request,
      output: "values.json",
      pointer: "/hr",
    });
    expect(value).toEqual({
      insert: { kind: "inline", source: "{\\resultAnalysisHr}" },
      macro: { name: "resultAnalysisHr", definition: "0.73" },
      preambleInput: "\\input{results/analysis/values.tex}",
      packages: [],
      files: ["paper/results/analysis/values.tex"],
    });
    const values = await place.read("paper/results/analysis/values.tex");
    expect(values).toContain("\\newcommand{\\resultAnalysisCohortN}{1229}");
    expect(values).toContain("\\newcommand{\\resultAnalysisHr}{0.73}");

    const table = await placeLatexResult(place.context(), {
      ...request,
      output: "table1.csv",
      pointer: null,
    });
    expect(table.insert.source).toBe(
      "\\begin{table}[htbp]\n\\centering\n\\caption{Results of analysis.py}\n\\label{tab:table1}\n\\input{results/analysis/table1.tex}\n\\end{table}",
    );
    expect(table.packages).toEqual(["booktabs"]);
    expect(await place.read("paper/results/analysis/table1.tex")).toContain("Treatment & 600 \\\\");

    const figure = await placeLatexResult(place.context(), {
      ...request,
      output: "km.pdf",
      pointer: null,
    });
    expect(figure.insert.source).toContain(
      "\\includegraphics[width=0.8\\textwidth]{results/analysis/km.pdf}",
    );
    expect(await place.read("paper/results/analysis/km.pdf")).toBe("%PDF-1");

    const status = await placementStatus(place.context(), {
      documentPath: "paper/main.tex",
      documentText: "",
      build: null,
    });
    expect(status.coverage).toBe("placed");
    expect(status.scripts[0]!.files.map((file) => [file.path, file.state])).toEqual([
      ["paper/results/analysis/values.tex", "current"],
      ["paper/results/analysis/table1.tex", "current"],
      ["paper/results/analysis/km.pdf", "current"],
    ]);
    expect(status.scripts[0]!.newer).toBeNull();
  });

  it("avoids macro names the paper or its included preamble already defines", async () => {
    const place = await setup();
    const revision = await place.publish(FIRST);
    const value = await placeLatexResult(place.context(), {
      documentPath: "main.tex",
      documentText: "\\newcommand{\\resultAnalysisHr}{x}",
      revision,
      output: "values.json",
      pointer: "/hr",
      now: at(50),
    });
    expect(value.insert.source).toBe("{\\resultAnalysisHrB}");
  });

  it("gives each output its own TeX-safe file and never overwrites one it did not place", async () => {
    const place = await setup();
    const revision = await place.publish({
      "tables/a.tex": "\\begin{tabular}{l}x\\end{tabular}",
      "supplement/a.tex": "\\begin{tabular}{l}y\\end{tabular}",
      "fig 50%.png": "png",
      "km.svg": "<svg/>",
    });
    await NodeFSP.mkdir(NodePath.join(place.root, "results", "analysis"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(place.root, "results", "analysis", "a.tex"), "mine");
    const request = { documentPath: "main.tex", documentText: "", revision, pointer: null };
    const first = await placeLatexResult(place.context(), {
      ...request,
      output: "tables/a.tex",
      now: at(50),
    });
    const second = await placeLatexResult(place.context(), {
      ...request,
      output: "supplement/a.tex",
      now: at(51),
    });
    expect(first.files).toEqual(["results/analysis/a-2.tex"]);
    expect(second.files).toEqual(["results/analysis/a-3.tex"]);
    expect(await place.read("results/analysis/a.tex")).toBe("mine");
    const figure = await placeLatexResult(place.context(), {
      ...request,
      output: "fig 50%.png",
      now: at(52),
    });
    expect(figure.files).toEqual(["results/analysis/fig-50.png"]);
    await expect(
      placeLatexResult(place.context(), { ...request, output: "km.svg", now: at(53) }),
    ).rejects.toThrow("LaTeX cannot include km.svg");
  });

  it("keeps one run per script in a paper", async () => {
    const place = await setup();
    const first = await place.publish(FIRST);
    const second = await place.publish(FIRST);
    const request = { documentPath: "main.tex", documentText: "", pointer: null, now: at(50) };
    await placeLatexResult(place.context(), { ...request, revision: first, output: "km.pdf" });
    await expect(
      placeLatexResult(place.context(), { ...request, revision: second, output: "table1.csv" }),
    ).rejects.toThrow("Update files first");
  });
});

describe("updating placed files", () => {
  async function placedPaper() {
    const place = await setup();
    const revision = await place.publish(FIRST);
    const request = { documentPath: "main.tex", documentText: "", revision, now: at(50) };
    await placeLatexResult(place.context(), { ...request, output: "values.json", pointer: "/hr" });
    await placeLatexResult(place.context(), { ...request, output: "table1.csv", pointer: null });
    return { ...place, first: revision };
  }
  const update = (
    toRevision: string,
    replaceEdited: ReadonlyArray<{ path: string; sha256: string }> = [],
  ) => ({
    documentPath: "main.tex",
    documentText: PAPER,
    script: "analysis.py",
    toRevision,
    replaceEdited,
    now: at(55),
  });
  const undo = { documentPath: "main.tex", script: "analysis.py" };

  it("replaces a script's files together, then undoes that", async () => {
    const place = await placedPaper();
    await NodeFSP.writeFile(NodePath.join(place.root, "analysis.py"), "print('refit')\n");
    let status = await place.status();
    expect(status.scripts[0]!.files.every((file) => file.state === "out-of-date")).toBe(true);

    const second = await place.publish(SECOND);
    status = await place.status();
    expect(status.scripts[0]!.newer?.revision).toBe(second);
    expect(status.scripts[0]!.changes).toEqual([
      "\\resultAnalysisCohortN: 1229 → 1178",
      "\\resultAnalysisHr: 0.73 → 0.75",
      "table1.tex: 2 cells change",
    ]);

    expect(await updatePlacedFiles(place.context(), update(second))).toEqual({
      _tag: "changed",
      files: ["results/analysis/values.tex", "results/analysis/table1.tex"],
    });
    expect(await place.read("results/analysis/values.tex")).toContain(
      "\\newcommand{\\resultAnalysisHr}{0.75}",
    );
    status = await place.status();
    expect(status.scripts[0]!.files.every((file) => file.state === "current")).toBe(true);
    expect(status.scripts[0]!.canUndo).toBe(true);

    expect(await undoPlacedFilesUpdate(place.context(), undo)).toEqual({
      _tag: "changed",
      files: ["results/analysis/values.tex", "results/analysis/table1.tex"],
    });
    expect(await place.read("results/analysis/values.tex")).toContain("{0.73}");
    status = await place.status();
    expect(status.scripts[0]!.newer).not.toBeNull();
    expect(status.scripts[0]!.canUndo).toBe(false);
  });

  it("only replaces the run and the edits the user was shown", async () => {
    const place = await placedPaper();
    const editedPath = NodePath.join(place.root, "results", "analysis", "table1.tex");
    await NodeFSP.writeFile(editedPath, "my table");
    const second = await place.publish(SECOND);

    expect(await updatePlacedFiles(place.context(), update(second))).toEqual({
      _tag: "refused",
      message: "results/analysis/table1.tex was edited after Scient placed it.",
      edited: [{ path: "results/analysis/table1.tex", sha256: sha256("my table") }],
    });
    // A further edit after the warning asks again.
    await NodeFSP.writeFile(editedPath, "my table, edited again");
    expect(
      await updatePlacedFiles(
        place.context(),
        update(second, [{ path: "results/analysis/table1.tex", sha256: sha256("my table") }]),
      ),
    ).toMatchObject({ _tag: "refused" });
    // So does a newer run than the one shown.
    const third = await place.publish(FIRST);
    expect(await updatePlacedFiles(place.context(), update(second))).toMatchObject({
      _tag: "refused",
      message: expect.stringContaining("A newer run"),
    });

    const confirmed = [
      { path: "results/analysis/table1.tex", sha256: sha256("my table, edited again") },
    ];
    expect(await updatePlacedFiles(place.context(), update(third, confirmed))).toMatchObject({
      _tag: "changed",
    });
    await undoPlacedFilesUpdate(place.context(), undo);
    expect(await place.read("results/analysis/table1.tex")).toBe("my table, edited again");
  });

  it("refuses a newer run without a value the paper uses, not one it never cites", async () => {
    const place = await placedPaper();
    const second = await place.publish({
      "values.json": '{"hr": "0.75"}',
      "table1.csv": FIRST["table1.csv"],
    });
    expect((await place.status(PAPER)).scripts[0]!.updateBlocked).toBe(
      "The newer run no longer produces cohort/n (\\resultAnalysisCohortN).",
    );
    expect(await updatePlacedFiles(place.context(), update(second))).toMatchObject({
      _tag: "refused",
    });
    expect((await place.status("\\resultAnalysisHr only")).scripts[0]!.updateBlocked).toBeNull();
  });

  it("changes nothing when one file cannot be written, and removes a file it recreated", async () => {
    const place = await placedPaper();
    await NodeFSP.rm(NodePath.join(place.root, "results", "analysis", "values.tex"));
    const second = await place.publish(SECOND);
    const result = await updatePlacedFiles(
      place.context(diskFiles(place.root, { "results/analysis/table1.tex": 0 })),
      update(second),
    );
    expect(result).toMatchObject({
      _tag: "refused",
      message: expect.stringContaining("Nothing was changed"),
    });
    await expect(place.read("results/analysis/values.tex")).rejects.toThrow();
    expect(await place.read("results/analysis/table1.tex")).toContain("Treatment & 600");
    expect((await place.status()).scripts[0]!.interrupted).toBe(false);
  });

  it("offers Undo when an update cannot put a file back", async () => {
    const place = await placedPaper();
    const second = await place.publish(SECOND);
    // values.tex is written, table1.tex fails, and putting values.tex back fails too.
    const files = diskFiles(place.root, {
      "results/analysis/table1.tex": 0,
      "results/analysis/values.tex": 1,
    });
    expect(await updatePlacedFiles(place.context(files), update(second))).toMatchObject({
      _tag: "refused",
      message: expect.stringContaining("could not be put back"),
    });
    let status = await place.status();
    expect(status.scripts[0]!.interrupted).toBe(true);
    expect(status.scripts[0]!.canUndo).toBe(true);
    expect(await undoPlacedFilesUpdate(place.context(), undo)).toMatchObject({ _tag: "changed" });
    expect(await place.read("results/analysis/values.tex")).toContain("{0.73}");
    status = await place.status();
    expect(status.scripts[0]!.interrupted).toBe(false);
    expect(status.scripts[0]!.files.every((file) => file.state === "current")).toBe(true);
  });

  it("will not undo once results were added after the update", async () => {
    const place = await placedPaper();
    const second = await place.publish(SECOND);
    await updatePlacedFiles(place.context(), update(second));
    await placeLatexResult(place.context(), {
      documentPath: "main.tex",
      documentText: "",
      revision: second,
      output: "km.pdf",
      pointer: null,
      now: at(57),
    });
    expect((await place.status()).scripts[0]!.canUndo).toBe(false);
    expect(await undoPlacedFilesUpdate(place.context(), undo)).toMatchObject({
      _tag: "refused",
      message: expect.stringContaining("mix two runs"),
    });
  });

  it("restores a missing file from its own run", async () => {
    const place = await placedPaper();
    await NodeFSP.rm(NodePath.join(place.root, "results", "analysis", "table1.tex"));
    expect((await place.status()).scripts[0]!.files[1]!.state).toBe("missing");
    expect(await updatePlacedFiles(place.context(), update(place.first))).toEqual({
      _tag: "changed",
      files: ["results/analysis/table1.tex"],
    });
    expect((await place.status()).scripts[0]!.files[1]!.state).toBe("current");
  });

  it("says which files the shown PDF read and whether it read these bytes", async () => {
    const place = await placedPaper();
    const status = await placementStatus(place.context(), {
      documentPath: "main.tex",
      documentText: "",
      build: { finishedAt: at(59), digests: { "results/analysis/values.tex": "sha256:0000" } },
    });
    expect(status.coverage).toBe("build");
    expect(
      status.scripts[0]!.files.map((file) => [file.path, file.usedByBuild, file.differsFromBuild]),
    ).toEqual([
      ["results/analysis/values.tex", true, true],
      ["results/analysis/table1.tex", false, false],
    ]);
    const empty = await placementStatus(place.context(), {
      documentPath: "main.tex",
      documentText: "",
      build: { finishedAt: at(59), digests: {} },
    });
    expect(empty.coverage).toBe("placed");
  });
});
