// @effect-diagnostics nodeBuiltinImport:off -- writes a real model file for NetLogo to read.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ExecutionRunId } from "@scientfactory/execution";
import {
  COMPUTE_LANGUAGE_CATALOG,
  COMPUTE_RUN_TABLE,
  computeRunnableTools,
  computeRunRouteForPath,
  computeRunRoutesForPath,
  isSqliteScript,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FoundLanguageTool } from "../compute/ToolScan.ts";
import {
  beside,
  lakeHasLeanCommand,
  makeRunTableAdapters,
  mathlibNeedsCache,
} from "./RunTableAdapter.ts";

const tool = (languageId: string, name: string, executable: string): FoundLanguageTool => ({
  languageId,
  name,
  executable,
  identity: executable,
  version: null,
  origin: null,
});

const adapterFor = (languageId: string, found: ReadonlyArray<FoundLanguageTool>) => {
  const adapter = makeRunTableAdapters({
    tools: async () => new Map([[languageId, found]]),
    environment: { PATH: "/usr/bin" },
    platform: "linux",
  }).find((candidate) => candidate.kind === languageId);
  if (adapter === undefined) throw new Error(`No route for ${languageId}.`);
  return adapter;
};

const inspect = (adapter: ReturnType<typeof adapterFor>, customExecutablePath?: string) =>
  adapter.inspect({
    inspectedAt: "2026-10-31T00:00:00.000Z",
    platform: "linux",
    environment: {},
    ...(customExecutablePath === undefined ? {} : { customExecutablePath }),
  });

const prepare = async (adapter: ReturnType<typeof adapterFor>, file: string, custom?: string) =>
  adapter.prepare({
    runId: ExecutionRunId.make("run"),
    projectId: "project",
    runtime: await inspect(adapter, custom),
    source: { cwd: "/project", relativePath: file, revision: "1" as never },
    absoluteSourcePath: `/project/${file}`,
    artifactStagingDirectory: "/staging",
  });

const found = (languageId: string, name: string, executable: string, version: string | null) => ({
  ...tool(languageId, name, executable),
  version,
});

describe("choosing what runs a file", () => {
  it("prefers a newer install over the copy the system came with", async () => {
    const adapter = adapterFor("java", [
      found("java", "java", "/usr/bin/java", null),
      found("java", "java", "/opt/homebrew/opt/openjdk@21/bin/java", "21.0.11"),
      found("java", "java", "/jvm/java-11/bin/java", "11.0.32"),
    ]);
    const profile = await inspect(adapter);
    expect(profile.executablePath).toBe("/opt/homebrew/opt/openjdk@21/bin/java");
    expect(profile.version).toBe("21.0.11");
  });

  it("compares versions as numbers", async () => {
    const adapter = adapterFor("javascript", [
      found("javascript", "node", "/usr/bin/node", "9.11.2"),
      found("javascript", "node", "/b/node", "24.19.0"),
    ]);
    expect((await inspect(adapter)).executablePath).toBe("/b/node");
  });

  it("keeps the copy someone put first on PATH, even when a newer one exists", async () => {
    const adapter = adapterFor("javascript", [
      found("javascript", "node", "/opt/homebrew/opt/node@24/bin/node", "24.19.0"),
      found("javascript", "node", "/opt/homebrew/opt/node/bin/node", "25.8.2"),
    ]);
    const profile = await inspect(adapter);
    expect(profile.version).toBe("24.19.0");
    expect(profile.alternatives?.map((tool) => tool.version)).toEqual(["25.8.2"]);
  });

  it("keeps the table's order of programs ahead of versions", async () => {
    const adapter = adapterFor("javascript", [
      found("javascript", "deno", "/a/deno", "99.0.0"),
      found("javascript", "node", "/b/node", "24.19.0"),
    ]);
    expect((await inspect(adapter)).executablePath).toBe("/b/node");
  });

  it("lets JAVA_HOME outrank the newest Java", async () => {
    const adapter = makeRunTableAdapters({
      tools: async () =>
        new Map([
          [
            "java",
            [
              found("java", "java", "/jdk/21/bin/java", "21.0.1"),
              found("java", "java", "/mine/jdk/bin/java", "17.0.1"),
            ],
          ],
        ]),
      environment: { PATH: "/usr/bin", JAVA_HOME: "/mine/jdk" },
      platform: "linux",
    }).find((candidate) => candidate.kind === "java")!;
    expect((await inspect(adapter)).executablePath).toBe("/mine/jdk/bin/java");
  });

  it("offers each other version once, and never the one that ran", async () => {
    const adapter = adapterFor("java", [
      found("java", "java", "/usr/bin/java", null),
      found("java", "java", "/a/21/bin/java", "21.0.11"),
      found("java", "java", "/b/21/bin/java", "21.0.11"),
      found("java", "java", "/c/11/bin/java", "11.0.32"),
    ]);
    expect((await inspect(adapter)).alternatives).toEqual([
      { executablePath: "/c/11/bin/java", label: "Java 11.0.32", version: "11.0.32" },
      { executablePath: "/usr/bin/java", label: "system java", version: null },
    ]);
  });

  it("offers nothing when the language is missing", async () => {
    expect((await inspect(adapterFor("java", []))).alternatives).toEqual([]);
  });
});

describe("how a file is built", () => {
  it("builds C++ to a modern standard with the math library", async () => {
    const step = await prepare(
      adapterFor("cpp", [found("cpp", "g++", "/usr/bin/g++", "13.2.0")]),
      "a.cpp",
    );
    expect(step.before?.[0]?.args).toEqual([
      "-std=gnu++2b",
      "/project/a.cpp",
      "-o",
      "/staging/program",
      "-lm",
    ]);
  });

  it("leaves the math library off on Windows, where linkers refuse it", async () => {
    const adapter = makeRunTableAdapters({
      tools: async () => new Map([["c", [found("c", "clang", "C:\\llvm\\clang.exe", "20.1.0")]]]),
      environment: { PATH: "C:\\llvm" },
      platform: "win32",
    }).find((candidate) => candidate.kind === "c")!;
    const step = await prepare(adapter, "a.c");
    expect(step.before?.[0]?.args).toEqual(["/project/a.c", "-o", "/staging/program.exe"]);
  });

  it("turns exceptions and the newest standard on for MSVC", async () => {
    const adapter = makeRunTableAdapters({
      tools: async () => new Map([["cpp", [found("cpp", "cl", "C:\\vc\\cl.exe", null)]]]),
      environment: { PATH: "C:\\vc" },
      platform: "win32",
    }).find((candidate) => candidate.kind === "cpp")!;
    const step = await prepare(adapter, "a.cpp");
    expect(step.before?.[0]?.args).toContain("/EHsc");
    expect(step.before?.[0]?.args).toContain("/std:c++latest");
  });

  it("gives Rust a current edition", async () => {
    const step = await prepare(
      adapterFor("rust", [found("rust", "rustc", "/usr/bin/rustc", "1.96.1")]),
      "a.rs",
    );
    expect(step.before?.[0]?.args.slice(0, 2)).toEqual(["--edition", "2021"]);
  });

  it("runs a sqlite3 script through sqlite3 itself", async () => {
    const step = await prepare(
      adapterFor("sqlite", [found("sqlite", "sqlite3", "/usr/bin/sqlite3", null)]),
      "a.sql",
    );
    expect(step.args).toEqual(["-bail", ":memory:", '.read "/project/a.sql"']);
  });

  it("passes a path whole, in the form each tool reads it", async () => {
    const step = await prepare(
      adapterFor("sqlite", [found("sqlite", "sqlite3", "/usr/bin/sqlite3", null)]),
      `O'Brien "x".sql`,
    );
    expect(step.args[2]).toBe(`.read "/project/O'Brien \\"x\\".sql"`);
    // Isabelle runs a theory by name, in its own folder.
    const theory = await prepare(
      adapterFor("isabelle", [found("isabelle", "isabelle", "/usr/bin/isabelle", null)]),
      "Proofs.thy",
    );
    expect(theory.args).toEqual(["process_theories", "-O", "-D", "/project", "Proofs"]);
  });

  it("runs a NetLogo model's first saved experiment, which is all NetLogo runs headless", async () => {
    const adapter = adapterFor("netlogo", [
      found("netlogo", "netlogo-headless", "/opt/NetLogo/netlogo-headless.sh", null),
    ]);
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-netlogo-"));
    const model = NodePath.join(folder, "Flock.nlogo");
    NodeFS.writeFileSync(
      model,
      [
        "to go end",
        "",
        // Its Info tab shows an example of the markup before the saved experiment.
        '## HOW TO USE IT\n<experiment name="example">',
        "",
        "",
        "",
        "",
        '<experiments><experiment name="Wind &amp; rain" repetitions="1"/></experiments>',
      ].join("\n@#$#@#$#@\n"),
    );
    const step = adapter.prepare({
      runId: ExecutionRunId.make("run"),
      projectId: "project",
      runtime: await inspect(adapter),
      source: { cwd: folder, relativePath: "Flock.nlogo", revision: "1" as never },
      absoluteSourcePath: model,
      artifactStagingDirectory: "/staging",
    });
    expect(step.args).toEqual(["--model", model, "--experiment", "Wind & rain", "--table", "-"]);
    // Without one, NetLogo is left to say what it needs.
    expect((await prepare(adapter, "Empty.nlogo")).args).toEqual([
      "--model",
      "/project/Empty.nlogo",
      "--table",
      "-",
    ]);
  });
});

describe("a Lean file in a Lake project", () => {
  /** A computer with Lean and Lake in `bin`, and these files in a folder whose name has a space. */
  const leanComputer = (files: Readonly<Record<string, string>>, withLake = true) => {
    const folder = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-lean ")),
    );
    const bin = NodePath.join(folder, "bin");
    NodeFS.mkdirSync(bin);
    for (const name of withLake ? ["lean", "lake"] : ["lean"]) {
      NodeFS.writeFileSync(NodePath.join(bin, name), "");
    }
    for (const [name, contents] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(folder, name)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(folder, name), contents);
    }
    const adapter = adapterFor("lean", [found("lean", "lean", NodePath.join(bin, "lean"), null)]);
    const run = async (relativePath: string) =>
      adapter.prepare({
        runId: ExecutionRunId.make("run"),
        projectId: "project",
        runtime: await inspect(adapter),
        source: { cwd: folder, relativePath, revision: "1" as never },
        absoluteSourcePath: NodePath.join(folder, relativePath),
        artifactStagingDirectory: "/staging",
      });
    return { folder, lake: NodePath.join(bin, "lake"), lean: NodePath.join(bin, "lean"), run };
  };

  it("runs a file outside any project with Lean alone, as before", async () => {
    const { folder, lean, run } = leanComputer({ "a.lean": "" });
    expect(await run("a.lean")).toMatchObject({
      executable: lean,
      args: [NodePath.join(folder, "a.lean")],
      cwd: folder,
    });
  });

  it("builds what the file imports through Lake, from the project's folder", async () => {
    const { folder, lake, run } = leanComputer({
      "proof/lakefile.toml": 'name = "proof"\n',
      "proof/Notes/Try it.lean": "",
    });
    const step = await run("proof/Notes/Try it.lean");
    expect(step).toMatchObject({
      executable: lake,
      args: ["-q", "lean", NodePath.join(folder, "proof", "Notes", "Try it.lean")],
      cwd: NodePath.join(folder, "proof"),
    });
    expect(step.before).toBeUndefined();
  });

  it("takes the nearest lakefile, and Lake's dependencies belong to the project above them", async () => {
    const { folder, run } = leanComputer({
      "outer/lakefile.lean": "",
      "outer/inner/lakefile.toml": "",
      "outer/inner/A.lean": "",
      "outer/.lake/packages/dep/lakefile.lean": "",
      "outer/.lake/packages/dep/Dep.lean": "",
    });
    expect((await run("outer/inner/A.lean")).cwd).toBe(NodePath.join(folder, "outer", "inner"));
    expect((await run("outer/.lake/packages/dep/Dep.lean")).cwd).toBe(
      NodePath.join(folder, "outer"),
    );
  });

  it("fetches Mathlib's ready-built files first when Mathlib is not built", async () => {
    const manifest = JSON.stringify({ name: "proof", packages: [{ name: "mathlib" }] });
    const { folder, lake, run } = leanComputer({
      "lakefile.toml": "",
      "lake-manifest.json": manifest,
      "A.lean": "",
    });
    expect((await run("A.lean")).before).toEqual([
      expect.objectContaining({ executable: lake, args: ["exe", "cache", "get"], cwd: folder }),
    ]);
    expect(mathlibNeedsCache(folder)).toBe(true);
    const built = NodePath.join(folder, ".lake/packages/mathlib/.lake/build/lib/lean");
    NodeFS.mkdirSync(built, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(built, "Mathlib.olean"), "");
    expect(mathlibNeedsCache(folder)).toBe(false);
    expect((await run("A.lean")).before).toBeUndefined();
  });

  it("leaves a project without Mathlib, or not yet resolved, to Lake", () => {
    const { folder } = leanComputer({ "lakefile.toml": "" });
    expect(mathlibNeedsCache(folder)).toBe(false);
    NodeFS.writeFileSync(
      NodePath.join(folder, "lake-manifest.json"),
      JSON.stringify({ name: "proof", packages: [{ name: "batteries" }] }),
    );
    expect(mathlibNeedsCache(folder)).toBe(false);
  });

  it("builds and then runs Lean in Lake's environment before Lean 4.8, which has no `lake lean`", async () => {
    const { folder, lake, run } = leanComputer({
      "lakefile.lean": "",
      "lean-toolchain": "leanprover/lean4:v4.7.0\n",
      "A.lean": "",
    });
    expect(await run("A.lean")).toMatchObject({
      executable: lake,
      args: ["env", "lean", NodePath.join(folder, "A.lean")],
      cwd: folder,
      before: [{ executable: lake, args: ["build"], cwd: folder }],
    });
    expect(lakeHasLeanCommand("leanprover/lean4:v4.0.0")).toBe(false);
    for (const toolchain of [
      "leanprover/lean4:v4.8.0",
      "leanprover/lean4:v4.36.0-rc2",
      "v4.12.1",
      "stable",
      "leanprover/lean4:nightly-2026-01-01",
      "",
      null,
    ]) {
      expect(lakeHasLeanCommand(toolchain), String(toolchain)).toBe(true);
    }
  });

  it("says to install Lean with elan when Lake is not beside Lean", async () => {
    const { run } = leanComputer({ "lakefile.toml": "", "A.lean": "" }, false);
    await expect(run("A.lean")).rejects.toMatchObject({
      reason: "runtime-missing",
      message: expect.stringContaining("Install Lean with elan"),
    });
  });

  it("finds Lake beside Lean on Windows, with its extension", () => {
    expect(beside("C:\\Users\\a\\.elan\\bin\\lean.exe", "lake", "win32")).toBe(
      "C:\\Users\\a\\.elan\\bin\\lake.exe",
    );
    expect(beside("/home/a/.elan/bin/lean", "lake", "linux")).toBe("/home/a/.elan/bin/lake");
  });
});

describe("the run table", () => {
  it("lists what Run can start in the order it tries them", () => {
    const route = COMPUTE_RUN_TABLE.find((candidate) => candidate.languageId === "javascript")!;
    const java = COMPUTE_RUN_TABLE.find((candidate) => candidate.languageId === "java")!;
    const tool = (name: string, executable = `/usr/bin/${name}`) => ({ name, executable });
    expect(
      computeRunnableTools(route, [
        tool("deno"),
        tool("node", "/Applications/Node.app"),
        tool("node"),
      ]),
    ).toEqual([tool("node"), tool("deno")]);
    // javac is found with Java, but on its own it only compiles.
    expect(computeRunnableTools(java, [tool("javac"), tool("java")])).toEqual([tool("java")]);
  });

  it("lists every language a shared file type could be", () => {
    const languages = (path: string) =>
      computeRunRoutesForPath(path).map((route) => route.languageId);
    expect(languages("plot.gp")).toEqual(["gnuplot", "gp"]);
    expect(languages("a.m")).toEqual(["octave", "magma"]);
    expect(languages("a.v")).toEqual(["coq", "verilog"]);
    expect(languages("a.pro")).toEqual(["idl", "prolog"]);
    expect(languages("Macro.C")).toEqual(["root", "c"]);
    expect(languages("a.nothing")).toEqual([]);
  });

  it("tells a sqlite3 script from plain SQL", () => {
    expect(isSqliteScript(".bail on\nselect 1;\n")).toBe(true);
    expect(isSqliteScript("  .mode csv\nselect 1;\n")).toBe(true);
    expect(isSqliteScript("select 1.5;\nselect a.b from a;\n")).toBe(false);
  });

  it("covers every catalog language except those with sessions", () => {
    const routed = new Set(COMPUTE_RUN_TABLE.map((route) => route.languageId));
    const catalog = COMPUTE_LANGUAGE_CATALOG.flatMap((group) => group.languages).map(
      (language) => language.languageId,
    );
    expect(catalog.filter((languageId) => !routed.has(languageId))).toEqual([
      "python",
      "r",
      "matlab",
      "sql",
      "julia",
    ]);
  });

  it("uses the best command found, in the table's order", async () => {
    const adapter = adapterFor("javascript", [
      tool("javascript", "deno", "/usr/bin/deno"),
      tool("javascript", "node", "/usr/bin/node"),
    ]);
    expect(await prepare(adapter, "a.js")).toMatchObject({
      executable: "/usr/bin/node",
      args: ["/project/a.js"],
      cwd: "/project",
    });
  });

  it("builds first, then runs what was built, in the run's own folder", async () => {
    const adapter = adapterFor("c", [tool("c", "gcc", "/usr/bin/gcc")]);
    expect(await prepare(adapter, "a.c")).toMatchObject({
      executable: "/staging/program",
      args: [],
      before: [
        { executable: "/usr/bin/gcc", args: ["/project/a.c", "-o", "/staging/program", "-lm"] },
      ],
    });
  });

  it("uses a built program's own runner", async () => {
    const adapter = adapterFor("verilog", [tool("verilog", "iverilog", "/opt/bin/iverilog")]);
    expect(await prepare(adapter, "a.sv")).toMatchObject({
      executable: "/opt/bin/vvp",
      args: ["/staging/program"],
    });
  });

  it("says a language is missing rather than guessing", async () => {
    const profile = await inspect(adapterFor("zig", []));
    expect(profile).toMatchObject({
      availability: "missing",
      executablePath: null,
      detail: "Zig was not found on this computer.",
    });
  });

  it("runs an added location the way its name says, or the language's usual way", async () => {
    const adapter = adapterFor("perl", []);
    expect(await prepare(adapter, "a.pl", "/home/ada/perl5/bin/perl")).toMatchObject({
      executable: "/home/ada/perl5/bin/perl",
      args: ["/project/a.pl"],
    });
    const profile = await inspect(adapter, "/home/ada/perl5/bin/perl");
    expect(profile).toMatchObject({ availability: "available", source: "custom" });
  });

  it("starts a Windows batch launcher through its command interpreter", async () => {
    const adapter = makeRunTableAdapters({
      tools: async () => new Map([["maxima", [tool("maxima", "maxima", "C:\\M\\maxima.bat")]]]),
      environment: { ComSpec: "C:\\Windows\\cmd.exe" },
      platform: "win32",
    }).find((candidate) => candidate.kind === "maxima")!;
    expect(await prepare(adapter as never, "a.mac")).toMatchObject({
      executable: "C:\\Windows\\cmd.exe",
      args: ["/d", "/c", "call", "C:\\M\\maxima.bat", "-b", "/project/a.mac"],
    });
  });

  it("finds an app bundle but does not try to start it", async () => {
    const profile = await inspect(
      adapterFor("stata", [tool("stata", "stata", "/Applications/Stata/StataMP.app")]),
    );
    expect(profile.availability).toBe("missing");
  });

  it("matches a file by its extension, keeping the case where it means something", () => {
    expect(computeRunRouteForPath("src/main.RS")?.languageId).toBe("rust");
    expect(computeRunRouteForPath("macro.C")?.languageId).toBe("root");
    expect(computeRunRouteForPath("main.c")?.languageId).toBe("c");
    expect(computeRunRouteForPath("notes.txt")).toBeUndefined();
  });
});
