// @effect-diagnostics nodeBuiltinImport:off -- the revision record is files on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeResultsReader, publishScriptRun, type SettledScriptRun } from "./resultRevisions.ts";

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
    languageId: "python",
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
