// @effect-diagnostics nodeBuiltinImport:off -- the revision record is files on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as effectIt } from "@effect/vitest";
import { ComputeExecutionId, ComputeProjectId, ComputeSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeNotebookReader } from "../notebook/notebookReader.ts";
import { compareResultRevisions } from "./resultComparison.ts";
import {
  beginResultAttempt,
  recordFailedResultAttempt,
  recoverResultAttempts,
} from "./resultAttempts.ts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  makeResultsReader,
  prepareResultRun,
  publishScriptRun,
  suggestedResultInputs,
  type SettledScriptRun,
} from "./resultRevisions.ts";

const folders: string[] = [];
let runs = 0;
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => NodeFSP.rm(folder, { recursive: true })));
});

async function project() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "linked-results-")),
  );
  folders.push(base);
  const root = NodePath.join(base, "project");
  const computeDir = NodePath.join(base, "compute");
  await NodeFSP.mkdir(NodePath.join(root, "data"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "analysis.py"), "print('fit')\n");
  await NodeFSP.writeFile(NodePath.join(root, "data", "cohort.csv"), "id\n1\n2\n");
  return { root, computeDir, layout: { computeDir } };
}

async function run(
  place: Awaited<ReturnType<typeof project>>,
  values: string,
  overrides: Partial<SettledScriptRun> = {},
): Promise<SettledScriptRun> {
  runs += 1;
  const executionId = `run-${runs}`;
  const stagingFolder = NodePath.join(place.computeDir, "results", "p", "staging", executionId);
  await NodeFSP.mkdir(stagingFolder, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(stagingFolder, "values.json"), values);
  await NodeFSP.writeFile(NodePath.join(stagingFolder, "km.png"), "png");
  const cohort = NodePath.join(place.root, "data", "cohort.csv");
  const status = await NodeFSP.stat(cohort, { bigint: true });
  return {
    projectId: "p",
    root: place.root,
    stagingFolder,
    succeeded: true,
    scriptPath: "analysis.py",
    language: "Python",
    code: await NodeFSP.readFile(NodePath.join(place.root, "analysis.py"), "utf8"),
    sessionId: "s",
    executionId,
    startedAt: null,
    finishedAt: `2026-11-18T07:00:${String(runs).padStart(2, "0")}.000Z`,
    threadId: undefined,
    runtime: { executable: "/usr/bin/python3", version: "3.12", fingerprint: null },
    reads: {
      files: [
        { path: cohort, size: Number(status.size), modifiedAtNs: status.mtimeNs.toString() },
        { path: NodePath.join(place.root, "analysis.py"), size: 13, modifiedAtNs: "0" },
      ],
      truncated: false,
    },
    ...overrides,
  };
}

describe("linked result revisions", () => {
  it("publishes a successful run and names what changed since", async () => {
    const place = await project();
    const published = await publishScriptRun(place.layout, await run(place, '{"hr": 0.720}'));
    if (published._tag !== "published") throw new Error(published.message);
    const { revision } = published.revision;
    expect(published.revision.inputs.files.map((input) => input.path)).toEqual(["data/cohort.csv"]);
    expect(published.revision.outputs.map((output) => [output.name, output.kind])).toEqual([
      ["km.png", "figure"],
      ["values.json", "values"],
    ]);

    const value = { revision, output: "values.json", pointer: "/hr" };
    const current = await makeResultsReader(place.layout, "p", place.root).resolve(value);
    expect(current).toMatchObject({ _tag: "resolved", value: "0.720", newer: null });
    if (current._tag === "resolved") expect(current.summary.causes).toEqual([]);

    await NodeFSP.appendFile(NodePath.join(place.root, "data", "cohort.csv"), "3\n");
    await NodeFSP.writeFile(NodePath.join(place.root, "analysis.py"), "print('refit')\n");
    const stale = await makeResultsReader(place.layout, "p", place.root).resolve(value);
    expect(stale._tag === "resolved" && stale.summary.causes).toEqual([
      { kind: "script-changed", path: "analysis.py" },
      { kind: "input-changed", path: "data/cohort.csv" },
    ]);

    const rerun = await publishScriptRun(place.layout, await run(place, '{"hr": 0.700}'));
    expect(rerun._tag).toBe("published");
    const newer = await makeResultsReader(place.layout, "p", place.root).resolve(value);
    expect(newer).toMatchObject({ _tag: "resolved", value: "0.720", newer: { value: "0.700" } });
    expect(newer._tag === "resolved" && newer.newer?.summary.causes).toEqual([]);
  });

  it("keeps a notebook sweep out of published results and default rerun setup", async () => {
    const place = await project();
    const scriptPath = "analysis.ipynb";
    const base = {
      scriptPath,
      kind: "notebook" as const,
    };
    const published = await publishScriptRun(
      place.layout,
      await run(place, '{"hr":0.5}', {
        ...base,
        parameters: [{ name: "threshold", source: "override", value: "0.5" }],
        declaredInputs: ["data/cohort.csv"],
      }),
    );
    const sweep = await publishScriptRun(
      place.layout,
      await run(place, '{"hr":0.7}', {
        ...base,
        publication: "alternative",
        parameters: [{ name: "threshold", source: "override", value: "0.7" }],
      }),
    );
    if (published._tag !== "published" || sweep._tag !== "published") {
      throw new Error("Expected both notebook settings to publish");
    }

    const reader = makeResultsReader(place.layout, "p", place.root);
    expect(await reader.list()).toMatchObject([
      {
        latest: { revision: published.revision.revision },
        values: [{ value: "0.5" }],
        revisions: 2,
      },
    ]);
    expect(await reader.setup(scriptPath)).toEqual({
      parameters: [{ name: "threshold", source: "override", value: "0.5" }],
      inputs: ["data/cohort.csv"],
    });
    expect(
      await prepareResultRun(place.layout, { ...place, projectId: "p", scriptPath }),
    ).toMatchObject({
      parameterJson: '{"threshold":0.5}',
      declaredSnapshots: [{ path: "data/cohort.csv" }],
    });
    expect(
      await reader.resolve({
        revision: published.revision.revision,
        output: "values.json",
        pointer: "/hr",
      }),
    ).toMatchObject({ value: "0.5", newer: null });
    expect(sweep.revision.script.codeSha256).toBe(published.revision.script.codeSha256);
  });

  effectIt.effect(
    "opens Reader outputs outside preview limits only while the revision files exist",
    () =>
      Effect.gen(function* () {
        const { place, path, folder } = yield* Effect.promise(async () => {
          const place = await project();
          const staged = await run(place, '{"n":1}', {
            kind: "notebook",
            scriptPath: "analysis.ipynb",
            code: { language: "python", cells: [] },
          });
          await NodeFSP.truncate(NodePath.join(staged.stagingFolder, "km.png"), 512 * 1024 + 1);
          for (const name of ["curve.pdf", "missing.pdf"]) {
            await NodeFSP.writeFile(NodePath.join(staged.stagingFolder, name), "%PDF-1.4\n");
          }
          const published = await publishScriptRun(place.layout, staged);
          if (published._tag !== "published") throw new Error(published.message);
          const folder = NodePath.join(
            place.computeDir,
            "results",
            "p",
            "revisions",
            published.revision.revision,
            "outputs",
          );
          await NodeFSP.unlink(NodePath.join(folder, "missing.pdf"));
          return { place, path: staged.scriptPath, folder };
        });
        const read = makeNotebookReader(place.computeDir, {
          project: () =>
            Effect.succeed({ projectId: ComputeProjectId.make("p"), root: place.root }),
          listAllExecutions: () => Effect.succeed([]),
        });
        const alternatives = yield* read({ cwd: place.root, path });
        expect(alternatives.runs[0]?.outputs).toEqual([
          { name: "curve.pdf", preview: null, retainedPath: NodePath.join(folder, "curve.pdf") },
          { name: "km.png", preview: null, retainedPath: NodePath.join(folder, "km.png") },
          { name: "missing.pdf", preview: null },
        ]);
      }),
  );

  it("offers the newest current revision for insertion when the project's inputs are restored", async () => {
    const place = await project();
    const cohort = NodePath.join(place.root, "data", "cohort.csv");
    const original = await NodeFSP.readFile(cohort);
    const first = await publishScriptRun(place.layout, await run(place, '{"hr": 0.800}'));
    const current = await publishScriptRun(place.layout, await run(place, '{"hr": 0.820}'));
    await NodeFSP.appendFile(cohort, "3\n");
    const latest = await publishScriptRun(place.layout, await run(place, '{"hr": 0.600}'));
    if (first._tag !== "published" || current._tag !== "published" || latest._tag !== "published") {
      throw new Error("Expected all three runs to publish");
    }

    await NodeFSP.writeFile(cohort, original);
    const restored = makeResultsReader(place.layout, "p", place.root);
    expect((await restored.list())[0]?.latest.revision).toBe(latest.revision.revision);
    expect((await restored.list(true))[0]).toMatchObject({
      latest: { revision: current.revision.revision, causes: [] },
      values: [{ value: "0.820" }],
      revisions: 3,
    });

    await NodeFSP.appendFile(cohort, "4\n");
    expect((await makeResultsReader(place.layout, "p", place.root).list(true))[0]).toMatchObject({
      latest: {
        revision: latest.revision.revision,
        causes: [{ kind: "input-changed", path: "data/cohort.csv" }],
      },
      values: [{ value: "0.600" }],
    });
  });

  it("reads publication feedback for the exact run, including an empty result directory", async () => {
    const place = await project();
    const successful = await run(place, '{"hr": 0.720, "n": 2}');
    await NodeFSP.writeFile(NodePath.join(successful.stagingFolder, "cohort.csv"), "id\n1\n");
    const runIdentity = (executionId: string) => ({
      projectId: ComputeProjectId.make("p"),
      sessionId: ComputeSessionId.make("s"),
      executionId: ComputeExecutionId.make(executionId),
      scriptPath: "analysis.py",
    });
    const saved = runIdentity(successful.executionId);
    const read = () => makeResultsReader(place.layout, "p", place.root);
    await beginResultAttempt(place.layout, saved);
    expect(await read().findPublication(saved)).toEqual({ _tag: "pending" });
    await publishScriptRun(place.layout, successful);
    const empty = await run(place, '{"n": 2}');
    const failed = runIdentity(empty.executionId);
    await NodeFSP.rm(empty.stagingFolder, { force: true, recursive: true });
    await NodeFSP.mkdir(empty.stagingFolder);
    const outcome = await publishScriptRun(place.layout, empty);
    if (outcome._tag !== "failed") throw new Error("Expected an empty result directory to fail");
    await recordFailedResultAttempt(place.layout, failed, {
      finishedAt: empty.finishedAt,
      status: "failed",
      message: outcome.message,
      hasExecution: true,
    });
    expect(await read().findPublication(failed)).toEqual({
      _tag: "failed",
      message: "The script wrote nothing to SCIENT_RESULTS_DIR, so no results were published.",
    });
    await recoverResultAttempts(place.layout, empty.finishedAt, async () => true);
    expect(await read().findPublication(saved)).toEqual({
      _tag: "published",
      count: 4,
      counts: { values: 2, tables: 1, figures: 1, files: 0 },
    });
    expect(await read().findPublication({ ...saved, scriptPath: "other.py" })).toEqual({
      _tag: "unavailable",
    });
  });

  it("records and checks declared and observed files in a linked data folder", async () => {
    const place = await project();
    const external = NodePath.join(place.root, "..", "external");
    await NodeFSP.mkdir(external);
    await NodeFSP.writeFile(NodePath.join(external, "declared.csv"), "n\n1\n");
    await NodeFSP.writeFile(NodePath.join(external, "observed.csv"), "n\n2\n");
    await NodeFSP.symlink(external, NodePath.join(place.root, "linked"), "junction");
    const setup = await prepareResultRun(place.layout, {
      projectId: "p",
      root: place.root,
      scriptPath: "analysis.py",
      inputs: ["linked/declared.csv"],
    });
    const observedPath = NodePath.join(place.root, "linked", "observed.csv");
    const status = await NodeFSP.stat(observedPath, { bigint: true });
    const published = await publishScriptRun(
      place.layout,
      await run(place, '{"n":1}', {
        ...setup,
        reads: {
          files: [
            {
              path: observedPath,
              size: Number(status.size),
              modifiedAtNs: status.mtimeNs.toString(),
              changedAtNs: status.ctimeNs.toString(),
            },
          ],
          truncated: false,
        },
      }),
    );
    expect(published).toMatchObject({
      _tag: "published",
      revision: {
        inputs: {
          files: [
            { path: "linked/declared.csv", origin: "declared", changedDuringRun: false },
            { path: "linked/observed.csv", changedDuringRun: false },
          ],
        },
      },
    });
    const latest = async () =>
      (await makeResultsReader(place.layout, "p", place.root).list())[0]?.latest;
    expect((await latest())?.causes).toEqual([]);
    await NodeFSP.writeFile(NodePath.join(external, "observed.csv"), "n\n3\n");
    expect((await latest())?.causes).toEqual([
      { kind: "input-changed", path: "linked/observed.csv" },
    ]);
    await expect(
      prepareResultRun(place.layout, {
        projectId: "p",
        root: place.root,
        scriptPath: "analysis.py",
        inputs: ["../external/observed.csv"],
      }),
    ).rejects.toThrow("project-relative");
  });

  it("reuses and clears overrides and declared inputs, expanding saved views at each run", async () => {
    const place = await project();
    const request = { projectId: "p", root: place.root, scriptPath: "analysis.py" };
    const view = NodePath.join(place.root, "cohort.sql");
    await NodeFSP.writeFile(view, "SELECT * FROM 'data/cohort.csv'");
    const setup = await prepareResultRun(place.layout, {
      ...request,
      parameters: { threshold: "0.500" },
      inputs: ["cohort.sql"],
    });
    expect(setup.parameterJson).toBe('{"threshold":0.500}');
    const first = await publishScriptRun(place.layout, await run(place, '{"n": 2}', setup));
    expect(first).toMatchObject({
      _tag: "published",
      revision: {
        parameters: [{ name: "threshold", value: "0.500", source: "override" }],
        inputs: {
          files: [
            { path: "cohort.sql", origin: "declared", changedDuringRun: false },
            { path: "data/cohort.csv", origin: "both", via: "cohort.sql", changedDuringRun: false },
          ],
        },
      },
    });
    await NodeFSP.writeFile(view, "SELECT * FROM 'data/next.csv'");
    await expect(prepareResultRun(place.layout, request)).rejects.toThrow(
      'Declared input "data/next.csv"',
    );
    expect(
      (await makeResultsReader(place.layout, "p", place.root).list())[0]?.latest.causes,
    ).toContainEqual({ kind: "input-changed", path: "cohort.sql" });
    await NodeFSP.writeFile(NodePath.join(place.root, "data", "next.csv"), "id\n3\n");
    expect(await prepareResultRun(place.layout, request)).toMatchObject({
      parameterJson: '{"threshold":0.500}',
      declaredSnapshots: [{ path: "cohort.sql" }, { path: "data/next.csv" }],
    });
    expect(
      await prepareResultRun(place.layout, { ...request, parameters: {}, inputs: [] }),
    ).toEqual({ parameters: [], declaredSnapshots: [], environment: { lockfiles: [] } });
  });

  it("records incomplete saved-view coverage for unmatched globs and dropped references", async () => {
    const place = await project();
    await NodeFSP.writeFile(
      NodePath.join(place.root, "cohort.sql"),
      "SELECT * FROM 'data/*.csv' UNION ALL SELECT * FROM 'other/*.csv' UNION ALL SELECT * FROM '../private.csv'",
    );
    const setup = await prepareResultRun(place.layout, {
      projectId: "p",
      root: place.root,
      scriptPath: "analysis.py",
      inputs: ["cohort.sql"],
    });
    expect(setup).toMatchObject({
      declaredSnapshots: [{ path: "cohort.sql" }, { path: "data/cohort.csv", via: "cohort.sql" }],
      unresolvedViewInputs: [
        { via: "cohort.sql", reference: "(outside the project)", reason: "unrecorded" },
        { via: "cohort.sql", reference: "other/*.csv", reason: "no-matches" },
      ],
    });
    await publishScriptRun(place.layout, await run(place, '{"n":2}', setup));
    expect(
      (await makeResultsReader(place.layout, "p", place.root).list())[0]?.latest,
    ).toMatchObject({ inputCoverageIncomplete: true });
  });

  it("reports when the matching file list of a saved view changes", async () => {
    const place = await project();
    await NodeFSP.writeFile(NodePath.join(place.root, "cohort.sql"), "SELECT * FROM 'data/*.csv'");
    const setup = await prepareResultRun(place.layout, {
      projectId: "p",
      root: place.root,
      scriptPath: "analysis.py",
      inputs: ["cohort.sql"],
    });
    const first = await publishScriptRun(place.layout, await run(place, '{"n":2}', setup));
    expect(first).toMatchObject({
      _tag: "published",
      revision: { inputs: { globs: [{ path: "data/*.csv", changedDuringRun: false }] } },
    });
    const causes = async () =>
      (await makeResultsReader(place.layout, "p", place.root).list())[0]?.latest.causes;
    expect(await causes()).toEqual([]);
    await NodeFSP.writeFile(NodePath.join(place.root, "data", "notes.txt"), "unrelated");
    expect(await causes()).toEqual([]);
    await NodeFSP.writeFile(NodePath.join(place.root, "data", "next.csv"), "id\n3\n");
    expect(await causes()).toEqual([{ kind: "input-changed", path: "data/*.csv" }]);
    const duringRun = await publishScriptRun(place.layout, await run(place, '{"n":3}', setup));
    expect(duringRun).toMatchObject({
      _tag: "published",
      revision: { inputs: { globs: [{ path: "data/*.csv", changedDuringRun: true }] } },
    });
    expect(await causes()).toEqual([{ kind: "input-changed-during-run", path: "data/*.csv" }]);
  });

  it("keeps an explicit root listing current when a paper creates placement folders", async () => {
    const place = await project();
    const sha256 = NodeCrypto.createHash("sha256").update('["analysis.py","data"]').digest("hex");
    const published = await publishScriptRun(
      place.layout,
      await run(place, '{"n":2}', {
        reads: { files: [], directories: [{ path: place.root, sha256 }], truncated: false },
      }),
    );
    expect(published).toMatchObject({
      _tag: "published",
      revision: {
        inputs: {
          directoryListingVersion: 3,
          directories: [{ path: ".", changedDuringRun: false }],
        },
      },
    });
    const latest = async () =>
      (await makeResultsReader(place.layout, "p", place.root).list())[0]?.latest.causes;
    for (const path of ["assets/results", "results/analysis", ".scient"]) {
      await NodeFSP.mkdir(NodePath.join(place.root, path), { recursive: true });
    }
    expect(await latest()).toEqual([]);
    await NodeFSP.mkdir(NodePath.join(place.root, "new-data"));
    expect(await latest()).toEqual([{ kind: "input-changed", path: "." }]);
  });

  it("checks directory membership separately from observed files and retains only the outside count", async () => {
    const place = await project();
    const data = NodePath.join(place.root, "data");
    const digest = NodeCrypto.createHash("sha256").update('["cohort.csv"]').digest("hex");
    const first = await publishScriptRun(
      place.layout,
      await run(place, '{"n":2}', {
        reads: {
          files: [],
          directories: [{ path: data, sha256: digest }],
          readsOutsideProject: 2,
          outsideDataPaths: ["~/Data/cohort.csv", "/datasets/study.parquet"],
          truncated: false,
        },
      }),
    );
    expect(first).toMatchObject({
      _tag: "published",
      revision: {
        inputs: {
          files: [],
          directories: [{ path: "data", sha256: digest, changedDuringRun: false }],
          readsOutsideProject: 2,
        },
      },
    });
    expect(
      (await makeResultsReader(place.layout, "p", place.root).list())[0]?.latest,
    ).toMatchObject({
      causes: [],
      observedDirectories: ["data"],
      readsOutsideProject: 2,
      outsideDataPaths: ["~/Data/cohort.csv", "/datasets/study.parquet"],
      inputCoverageIncomplete: true,
      observedInputCount: 0,
    });
    await NodeFSP.writeFile(NodePath.join(data, "new.csv"), "id\n3\n");
    expect(
      (await makeResultsReader(place.layout, "p", place.root).list())[0]?.latest.causes,
    ).toEqual([{ kind: "input-changed", path: "data" }]);
  });

  it("suggests existing literal inputs for languages with no read recorder", async () => {
    const { root } = await project();
    await NodeFSP.writeFile(NodePath.join(root, "ignored.csv"), "id\n1\n");
    const programs = [
      ["analysis.R", '# "ignored.csv"\nread.csv("data/cohort.csv"); read.csv("missing.csv")'],
      ["analysis.jl", '#= "ignored.csv" =#\nCSV.read("data/cohort.csv", DataFrame)'],
      ["analysis.sql", "/* 'ignored.csv' */ SELECT * FROM 'data/cohort.csv'"],
      ["analysis.m", "% 'ignored.csv'\nreadtable('data/cohort.csv'); readtable('../outside.csv')"],
    ] as const;
    for (const [path, code] of programs)
      expect(await suggestedResultInputs(root, path, code)).toEqual(["data/cohort.csv"]);
    expect(await suggestedResultInputs(root, "analysis.py", 'open("data/cohort.csv")')).toEqual([]);
  });

  it("retains run-start lockfile hashes and reports changes and removals", async () => {
    const place = await project();
    const lock = NodePath.join(place.root, "uv.lock");
    const requirements = NodePath.join(place.root, "requirements-dev.txt");
    await NodeFSP.writeFile(lock, "version = 1");
    await NodeFSP.writeFile(requirements, "pytest==8.2.0");
    await NodeFSP.writeFile(NodePath.join(place.root, "data", "renv.lock"), "{}");
    const setup = await prepareResultRun(place.layout, {
      projectId: "p",
      root: place.root,
      scriptPath: "analysis.py",
    });
    await NodeFSP.writeFile(lock, "version = 2");
    await NodeFSP.rm(requirements);
    expect(await publishScriptRun(place.layout, await run(place, '{"n":2}', setup))).toMatchObject({
      _tag: "published",
      revision: {
        environment: {
          lockfiles: [{ path: "requirements-dev.txt" }, { path: "uv.lock" }],
        },
      },
    });
    expect(
      (await makeResultsReader(place.layout, "p", place.root).list())[0]?.latest.causes,
    ).toEqual([
      { kind: "lockfile-changed", path: "requirements-dev.txt" },
      { kind: "lockfile-changed", path: "uv.lock" },
    ]);
  });

  it("recovers an interrupted attempt without hiding the last good value", async () => {
    const place = await project();
    const original = await publishScriptRun(place.layout, await run(place, '{"hr":0.720}'));
    if (original._tag !== "published") throw new Error(original.message);
    const pending = {
      projectId: ComputeProjectId.make("p"),
      sessionId: ComputeSessionId.make("session-interrupted"),
      executionId: ComputeExecutionId.make("in-flight"),
      scriptPath: "analysis.py",
    };
    const staging = NodePath.join(
      place.computeDir,
      "results",
      "p",
      "staging",
      pending.sessionId,
      pending.executionId,
    );
    await beginResultAttempt(place.layout, pending);
    await NodeFSP.mkdir(staging, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(staging, "values.json"), '{"hr":999}');
    await recoverResultAttempts(
      place.layout,
      original.revision.run.finishedAt.replace(/:\d{2}\.000Z$/u, ":59.000Z"),
      async () => false,
    );
    const afterRestart = makeResultsReader(place.layout, "p", place.root);
    expect((await afterRestart.list())[0]).toMatchObject({
      revisions: 1,
      values: [{ value: "0.720" }],
      lastAttempt: {
        status: "cancelled",
        sessionId: pending.sessionId,
        executionId: pending.executionId,
      },
    });
    expect(
      await afterRestart.resolve({
        revision: original.revision.revision,
        output: "values.json",
        pointer: "/hr",
      }),
    ).toMatchObject({ _tag: "resolved", value: "0.720", newer: null });
    await expect(NodeFSP.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    const retry = await publishScriptRun(
      place.layout,
      await run(place, '{"hr":0.718}', { finishedAt: "2026-11-18T07:01:00.000Z" }),
    );
    expect(retry._tag).toBe("published");
    expect((await makeResultsReader(place.layout, "p", place.root).list())[0]).toMatchObject({
      revisions: 2,
      values: [{ value: "0.718" }],
      lastAttempt: null,
    });
  });

  it("reports equal input bytes separately from changed evidence", async () => {
    const place = await project();
    const observed = await publishScriptRun(place.layout, await run(place, '{"n":2}'));
    const declared = await publishScriptRun(
      place.layout,
      await run(place, '{"n":2}', {
        declaredInputs: ["data/cohort.csv"],
        reads: undefined,
      }),
    );
    if (observed._tag !== "published" || declared._tag !== "published")
      throw new Error("Expected stored revisions");
    await NodeFSP.writeFile(NodePath.join(place.root, "data/cohort.csv"), "outcome\n1\n");
    const changed = await publishScriptRun(place.layout, await run(place, '{"n":1}'));
    if (changed._tag !== "published") throw new Error("Expected a revision with new input bytes");
    const reader = makeResultsReader(place.layout, "p", place.root);
    const prior = await reader.summary(observed.revision);
    expect(prior.inputFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect((await reader.summary(declared.revision)).inputFingerprint).toBe(prior.inputFingerprint);
    const next = await reader.summary(changed.revision);
    expect(next.inputFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(next.inputFingerprint).not.toBe(prior.inputFingerprint);
    expect(
      (await compareResultRevisions(reader, observed.revision, declared.revision)).inputs,
    ).toEqual([
      {
        path: "data/cohort.csv",
        change: "same",
        evidence: {
          from: { origin: "observed", changedDuringRun: false },
          to: { origin: "declared", changedDuringRun: false },
        },
      },
    ]);
  });

  it("compares stored notebook revisions with literal values, typed deltas, and evidence", async () => {
    const place = await project();
    const first = await publishScriptRun(
      place.layout,
      await run(place, '{"hr":0.720,"large":9007199254740992,"text":"100","same":1}', {
        kind: "notebook",
        scriptPath: "analysis.ipynb",
        parameters: [{ name: "cutoff", value: "50", source: "default" }],
        environment: {
          lockfiles: [{ path: "uv.lock", sha256: "a".repeat(64) }],
          packages: [
            { name: "Fancy_Package", version: "1.0" },
            { name: "gone", version: "3" },
          ],
        },
      }),
    );
    const second = await publishScriptRun(
      place.layout,
      await run(place, '{"hr":0.900,"large":9007199254740993,"text":"200","same":1}', {
        kind: "notebook",
        scriptPath: "analysis.ipynb",
        code: "run_new_model()",
        parameters: [{ name: "cutoff", value: "60", source: "override" }],
        environment: {
          lockfiles: [{ path: "uv.lock", sha256: "b".repeat(64) }],
          packages: [
            { name: "fancy-package", version: "2.0" },
            { name: "new", version: "1" },
          ],
        },
      }),
    );
    if (first._tag !== "published" || second._tag !== "published")
      throw new Error("Missing test revision");
    const diff = await compareResultRevisions(
      makeResultsReader(place.layout, "p", place.root),
      first.revision,
      second.revision,
    );
    expect(diff).toMatchObject({
      from: { kind: "notebook" },
      codeChanged: true,
      parameters: [{ name: "cutoff", from: "50", to: "60" }],
      environment: [
        { name: "uv.lock", kind: "lockfile" },
        { name: "fancy-package", from: "1.0", to: "2.0", kind: "package" },
        { name: "gone", from: "3", to: null, kind: "package" },
        { name: "new", from: null, to: "1", kind: "package" },
      ],
      outputs: [
        { name: "km.png", change: "same" },
        { name: "values.json", change: "changed" },
      ],
      valuesTruncated: false,
    });
    const [hr, large, text, same] = diff.values;
    expect(hr).toMatchObject({ pointer: "/hr", from: "0.720", to: "0.900" });
    expect(hr?.delta).toBeCloseTo(0.18);
    expect(hr?.relativeChange).toBeCloseTo(0.25);
    expect(large).toMatchObject({
      pointer: "/large",
      from: "9007199254740992",
      to: "9007199254740993",
      delta: 1,
      relativeChange: 1 / 9007199254740992,
    });
    expect(same).toMatchObject({ from: "1", to: "1" });
    expect(text).toEqual({ output: "values.json", pointer: "/text", from: "100", to: "200" });
  });

  it("prioritizes changed values across files and beyond the unchanged preview limit", async () => {
    const place = await project();
    const unchanged = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`a${String(index).padStart(3, "0")}`, index]),
    );
    const publish = async (last: number, extra: Record<string, number> = {}) => {
      const staged = await run(place, JSON.stringify({ ...unchanged, z: last, ...extra }));
      await NodeFSP.rename(
        NodePath.join(staged.stagingFolder, "values.json"),
        NodePath.join(staged.stagingFolder, "a_values.json"),
      );
      await NodeFSP.writeFile(
        NodePath.join(staged.stagingFolder, "z_metrics.json"),
        JSON.stringify({ last }),
      );
      const result = await publishScriptRun(place.layout, staged);
      if (result._tag !== "published") throw new Error(result.message);
      return result.revision;
    };
    const from = await publish(1);
    const to = await publish(2);
    const read = makeResultsReader(place.layout, "p", place.root);
    const diff = await compareResultRevisions(read, from, to);
    expect(diff.values).toHaveLength(500);
    expect(diff.values.slice(0, 2)).toMatchObject([
      { output: "a_values.json", pointer: "/z", from: "1", to: "2" },
      { output: "z_metrics.json", pointer: "/last", from: "1", to: "2" },
    ]);
    expect(diff.valuesTruncated).toBe(false);
    expect((await compareResultRevisions(read, from, from)).valuesTruncated).toBe(false);

    const many = await publish(
      2,
      Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`extra${index}`, 1])),
    );
    const capped = await compareResultRevisions(read, to, many);
    expect(capped.values).toHaveLength(500);
    expect(capped.values.every(({ from, to }) => from !== to)).toBe(true);
    expect(capped.valuesTruncated).toBe(true);
  });

  it("tracks notebook override changes separately from edits to code cells", async () => {
    const place = await project();
    const scriptPath = "analysis.ipynb";
    const authored = ["cutoff = 50", "print(cutoff)"] as const;
    const publish = (cutoff: number) =>
      run(place, JSON.stringify({ cutoff }), {
        kind: "notebook",
        scriptPath,
        code: {
          language: "python",
          cells: [
            { id: "defaults", cellType: "code", source: authored[0], parameterCell: true },
            {
              id: "injected",
              cellType: "code",
              source: `cutoff = ${cutoff}`,
              injectedParameters: true,
            },
            { id: "analysis", cellType: "code", source: authored[1] },
          ],
        },
        reads: undefined,
        parameters: [{ name: "cutoff", value: String(cutoff), source: "override" }],
      }).then((settled) => publishScriptRun(place.layout, settled));
    const first = await publish(60);
    const second = await publish(70);
    if (first._tag !== "published" || second._tag !== "published")
      throw new Error("Missing test revision");

    const path = NodePath.join(place.root, scriptPath);
    const saveNotebook = (lastCell: string | null, parameterCell = true, language = "python") =>
      NodeFSP.writeFile(
        path,
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: { language_info: { name: language } },
          cells: [
            {
              id: "defaults",
              cell_type: "code",
              metadata: { tags: parameterCell ? ["parameters"] : [] },
              source: lastCell === null ? authored.join("\n") : authored[0],
            },
            {
              id: "injected",
              cell_type: "code",
              metadata: { tags: ["injected-parameters"] },
              source: "cutoff = 70",
            },
            ...(lastCell === null
              ? []
              : [{ id: "analysis", cell_type: "code", metadata: {}, source: lastCell }]),
          ],
        }),
      );
    await saveNotebook(authored[1]!);
    const diff = await compareResultRevisions(
      makeResultsReader(place.layout, "p", place.root),
      first.revision,
      second.revision,
    );
    expect(first.revision.script.sha256).not.toBe(second.revision.script.sha256);
    expect(diff).toMatchObject({
      codeChanged: false,
      from: { causes: [] },
      to: { causes: [] },
      parameters: [{ name: "cutoff", from: "60", to: "70" }],
    });
    for (const change of [
      () => saveNotebook(null),
      () => saveNotebook(authored[1], false),
      () => saveNotebook(authored[1], true, "julia"),
    ]) {
      await change();
      expect(
        (await makeResultsReader(place.layout, "p", place.root).list())[0]?.latest.causes,
      ).toContainEqual({ kind: "script-changed", path: scriptPath });
    }
    const missingIdentity = await publishScriptRun(
      place.layout,
      await run(place, "{}", {
        kind: "notebook",
        scriptPath,
        code: authored.join("\n"),
        reads: undefined,
      }),
    );
    if (missingIdentity._tag !== "published") throw new Error(missingIdentity.message);
    const reader = makeResultsReader(place.layout, "p", place.root);
    expect(
      (await compareResultRevisions(reader, first.revision, missingIdentity.revision)).codeChanged,
    ).toBeNull();
    expect(
      (await makeResultsReader(place.layout, "p", place.root).list())[0]?.latest.causes,
    ).toEqual([{ kind: "script-unconfirmed", path: scriptPath }]);
  });

  it("keeps the last published notebook revision when every new output exceeds retention", async () => {
    const place = await project();
    const source = { kind: "notebook" as const, scriptPath: "analysis.ipynb" };
    const baseline = await publishScriptRun(place.layout, await run(place, '{"n":1}', source));
    if (baseline._tag !== "published") throw new Error(baseline.message);
    const oversized = await run(place, '{"n":2}', source);
    for (const name of ["values.json", "km.png"]) {
      await NodeFSP.truncate(NodePath.join(oversized.stagingFolder, name), 65 * 1024 * 1024);
    }
    expect(await publishScriptRun(place.layout, oversized)).toMatchObject({
      _tag: "failed",
      empty: "nothing-retained",
    });
    const reader = makeResultsReader(place.layout, "p", place.root);
    expect((await reader.revisions()).map(({ revision }) => revision)).toEqual([
      baseline.revision.revision,
    ]);
    expect((await reader.latestPublished(source.scriptPath))?.revision).toBe(
      baseline.revision.revision,
    );
  });

  it("reads only a named published output and signals the byte cap", async () => {
    const place = await project();
    const staged = await run(place, '{"n":2}');
    const csv = "id,label\n1,positive\n";
    await NodeFSP.writeFile(NodePath.join(staged.stagingFolder, "confusion.csv"), csv);
    await NodeFSP.writeFile(
      NodePath.join(staged.stagingFolder, "large.csv"),
      "x".repeat(16383) + "é\n",
    );
    const published = await publishScriptRun(place.layout, staged);
    if (published._tag !== "published") throw new Error(published.message);
    const revision = published.revision.revision;
    const read = makeResultsReader(place.layout, "p", place.root);
    expect(await read.outputContent(revision, "confusion.csv")).toMatchObject({
      _tag: "content",
      encoding: "utf8",
      content: csv,
      truncated: false,
    });
    expect(await read.outputContent(revision, "large.csv")).toMatchObject({
      _tag: "content",
      encoding: "utf8",
      content: "x".repeat(16383),
      truncated: true,
    });
    expect(await read.outputContent(revision, "../confusion.csv")).toEqual({
      _tag: "unavailable",
      reason: "missing",
    });
  });

  it("publishes nothing from a failed or empty run, and discards its folder", async () => {
    const place = await project();
    const failed = await run(place, "{}", { succeeded: false });
    expect(await publishScriptRun(place.layout, failed)).toMatchObject({ _tag: "failed" });
    await expect(NodeFSP.stat(failed.stagingFolder)).rejects.toThrow();
    expect(await makeResultsReader(place.layout, "p", place.root).list()).toEqual([]);
    const unknown = await makeResultsReader(place.layout, "p", place.root).resolve({
      revision: "r0123456789ab",
      output: "values.json",
      pointer: "/hr",
    });
    expect(unknown).toEqual({ _tag: "unrecorded" });
  });
});
