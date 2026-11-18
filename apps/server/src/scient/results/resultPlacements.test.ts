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

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const at = (second: number) => `2026-11-18T08:00:${String(second).padStart(2, "0")}.000Z`;

/** The project's files as the server writer treats them: a write only lands on what was expected. */
function diskFiles(root: string, failOn: { path?: string } = {}): ProjectFiles {
  return {
    read: async (path) => {
      const bytes = await NodeFSP.readFile(NodePath.join(root, path)).catch(() => null);
      return bytes === null ? null : new Uint8Array(bytes);
    },
    write: async (path, bytes, expected) => {
      if (path === failOn.path) throw new Error("EBUSY: file is open");
      const target = NodePath.join(root, path);
      const current = await NodeFSP.readFile(target).catch(() => null);
      if (expected === null ? current !== null : current === null || sha256(current) !== expected)
        return false;
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(target, bytes);
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
    await NodeFSP.mkdir(stagingFolder, { recursive: true });
    for (const [name, contents] of Object.entries(outputs))
      await NodeFSP.writeFile(NodePath.join(stagingFolder, name), contents);
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
      finishedAt: at(runs),
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
  return { root, publish, context, read };
}

const FIRST = {
  "values.json": '{"cohort": {"n": 1229}, "hr": "0.73"}',
  "table1.csv": "Arm,n\nTreatment,600\nControl,629\n",
  "km.pdf": "%PDF-1",
};

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

  it("avoids macro names the paper already defines", async () => {
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

  it("refuses to overwrite a file it did not place", async () => {
    const place = await setup();
    const revision = await place.publish(FIRST);
    await NodeFSP.mkdir(NodePath.join(place.root, "results", "analysis"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(place.root, "results", "analysis", "km.pdf"), "mine");
    await expect(
      placeLatexResult(place.context(), {
        documentPath: "main.tex",
        documentText: "",
        revision,
        output: "km.pdf",
        pointer: null,
        now: at(50),
      }),
    ).rejects.toThrow("already exists and was not placed by Scient");
    expect(await place.read("results/analysis/km.pdf")).toBe("mine");
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
    return place;
  }
  const update = { documentPath: "main.tex", documentText: "", script: "analysis.py", now: at(55) };

  it("replaces a script's files together, then undoes that", async () => {
    const place = await placedPaper();
    await NodeFSP.writeFile(NodePath.join(place.root, "analysis.py"), "print('refit')\n");
    let status = await placementStatus(place.context(), { documentPath: "main.tex", build: null });
    expect(status.scripts[0]!.files.every((file) => file.state === "out-of-date")).toBe(true);

    await place.publish({
      "values.json": '{"cohort": {"n": 1178}, "hr": "0.75"}',
      "table1.csv": "Arm,n\nTreatment,570\nControl,608\n",
    });
    status = await placementStatus(place.context(), { documentPath: "main.tex", build: null });
    expect(status.scripts[0]!.newer).not.toBeNull();
    expect(status.scripts[0]!.updateBlocked).toBeNull();
    expect(status.scripts[0]!.changes).toEqual([
      "\\resultAnalysisCohortN: 1229 → 1178",
      "\\resultAnalysisHr: 0.73 → 0.75",
      "table1.tex: 2 cells change",
    ]);

    const result = await updatePlacedFiles(place.context(), { ...update, replaceEdited: false });
    expect(result).toEqual({
      _tag: "changed",
      files: ["results/analysis/values.tex", "results/analysis/table1.tex"],
    });
    expect(await place.read("results/analysis/values.tex")).toContain(
      "\\newcommand{\\resultAnalysisHr}{0.75}",
    );
    expect(await place.read("results/analysis/table1.tex")).toContain("Treatment & 570");
    status = await placementStatus(place.context(), { documentPath: "main.tex", build: null });
    expect(status.scripts[0]!.files.every((file) => file.state === "current")).toBe(true);
    expect(status.scripts[0]!.canUndo).toBe(true);

    expect(
      await undoPlacedFilesUpdate(place.context(), {
        documentPath: "main.tex",
        script: "analysis.py",
      }),
    ).toEqual({
      _tag: "changed",
      files: ["results/analysis/values.tex", "results/analysis/table1.tex"],
    });
    expect(await place.read("results/analysis/values.tex")).toContain(
      "\\newcommand{\\resultAnalysisHr}{0.73}",
    );
    status = await placementStatus(place.context(), { documentPath: "main.tex", build: null });
    expect(status.scripts[0]!.newer).not.toBeNull();
    expect(status.scripts[0]!.canUndo).toBe(false);
  });

  it("asks before replacing a hand edit, and Undo brings the edit back", async () => {
    const place = await placedPaper();
    await NodeFSP.writeFile(
      NodePath.join(place.root, "results", "analysis", "table1.tex"),
      "my table",
    );
    await place.publish(FIRST);
    let status = await placementStatus(place.context(), { documentPath: "main.tex", build: null });
    expect(status.scripts[0]!.files.find((file) => file.path.endsWith("table1.tex"))!.state).toBe(
      "edited",
    );

    const refused = await updatePlacedFiles(place.context(), { ...update, replaceEdited: false });
    expect(refused).toMatchObject({ _tag: "refused", edited: ["results/analysis/table1.tex"] });
    expect(await place.read("results/analysis/table1.tex")).toBe("my table");

    await updatePlacedFiles(place.context(), { ...update, replaceEdited: true });
    expect(await place.read("results/analysis/table1.tex")).toContain("Treatment & 600");
    await undoPlacedFilesUpdate(place.context(), {
      documentPath: "main.tex",
      script: "analysis.py",
    });
    expect(await place.read("results/analysis/table1.tex")).toBe("my table");
    status = await placementStatus(place.context(), { documentPath: "main.tex", build: null });
    expect(status.scripts[0]!.files.find((file) => file.path.endsWith("table1.tex"))!.state).toBe(
      "edited",
    );
  });

  it("refuses a newer run that no longer produces a value the paper uses", async () => {
    const place = await placedPaper();
    await place.publish({ "values.json": '{"hr": "0.75"}', "table1.csv": FIRST["table1.csv"] });
    const status = await placementStatus(place.context(), {
      documentPath: "main.tex",
      build: null,
    });
    expect(status.scripts[0]!.updateBlocked).toBe(
      "The newer run no longer produces cohort/n (\\resultAnalysisCohortN).",
    );
    expect(
      await updatePlacedFiles(place.context(), { ...update, replaceEdited: false }),
    ).toMatchObject({ _tag: "refused" });
    expect(await place.read("results/analysis/values.tex")).toContain("{1229}");
  });

  it("changes nothing when one file cannot be written", async () => {
    const place = await placedPaper();
    await place.publish({
      "values.json": '{"cohort": {"n": 1178}, "hr": "0.75"}',
      "table1.csv": "Arm,n\nTreatment,570\nControl,608\n",
    });
    const result = await updatePlacedFiles(
      place.context(diskFiles(place.root, { path: "results/analysis/table1.tex" })),
      { ...update, replaceEdited: false },
    );
    expect(result).toMatchObject({ _tag: "refused" });
    expect(await place.read("results/analysis/values.tex")).toContain("{0.73}");
    expect(await place.read("results/analysis/table1.tex")).toContain("Treatment & 600");
  });

  it("says when the shown PDF was built from other bytes", async () => {
    const place = await placedPaper();
    const status = await placementStatus(place.context(), {
      documentPath: "main.tex",
      build: {
        finishedAt: at(59),
        digests: { "results/analysis/values.tex": "sha256:0000" },
      },
    });
    expect(status.coverage).toBe("build");
    expect(status.scripts[0]!.files.map((file) => [file.path, file.differsFromBuild])).toEqual([
      ["results/analysis/values.tex", true],
      ["results/analysis/table1.tex", false],
    ]);
  });
});
