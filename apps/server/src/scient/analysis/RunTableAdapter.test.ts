// @effect-diagnostics nodeBuiltinImport:off -- writes a real model file for NetLogo to read.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AnalysisOperationError } from "@scientfactory/analysis";
import { ExecutionRunId } from "@scientfactory/execution";
import {
  COMPUTE_LANGUAGE_CATALOG,
  COMPUTE_RUN_TABLE,
  computeRunnableTools,
  computeRunRouteForPath,
  computeRunRoutesForPath,
  isSqliteScript,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { FoundLanguageTool } from "../compute/ToolScan.ts";
import {
  beside,
  lakeHasLeanCommand,
  makeRunTableAdapters,
  mathlibNeedsCache,
} from "./RunTableAdapter.ts";
import { stanServerBuilds } from "./StanRun.ts";

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

describe("Stata and SAS, which write their results to files", () => {
  const prepareOn = async (
    platform: NodeJS.Platform,
    languageId: string,
    executable: string,
    cwd: string,
    absoluteSourcePath: string,
  ) => {
    const adapter = makeRunTableAdapters({
      tools: async () => new Map([[languageId, [tool(languageId, languageId, executable)]]]),
      environment: {},
      platform,
    }).find((candidate) => candidate.kind === languageId)!;
    const runtime = await adapter.inspect({
      inspectedAt: "2026-11-09T00:00:00.000Z",
      platform,
      environment: {},
    });
    return adapter.prepare({
      runId: ExecutionRunId.make("run"),
      projectId: "project",
      runtime,
      source: { cwd, relativePath: "a", revision: "1" as never },
      absoluteSourcePath,
      artifactStagingDirectory: "/staging",
    });
  };

  it("runs console Stata in batch mode, without its logo", async () => {
    const step = await prepareOn("linux", "stata", "/usr/local/stata19/stata-mp", "/p", "/p/a.do");
    expect(step.args).toEqual(["-q", "-b", "do", "/p/a.do"]);
  });

  it("quotes a path with a space, since Stata reads its words as one command", async () => {
    const step = await prepareOn(
      "linux",
      "stata",
      "/usr/local/stata19/stata",
      "/p q",
      "/p q/a b.do",
    );
    expect(step.args).toEqual(["-q", "-b", "do", '"/p q/a b.do"']);
  });

  it("runs a Mac window Stata with -e, since -b waits on a dialog when done", async () => {
    const executable = "/Applications/Stata/StataMP.app/Contents/MacOS/StataMP";
    const step = await prepareOn("darwin", "stata", executable, "/p", "/p/a.do");
    expect(step.args).toEqual(["-q", "-e", "do", "/p/a.do"]);
  });

  it("runs Windows Stata with /e, since /b waits for a click when done", async () => {
    const executable = "C:\\Program Files\\Stata19\\StataMP-64.exe";
    const step = await prepareOn("win32", "stata", executable, "C:\\p q", "C:\\p q\\a.do");
    expect(step).toMatchObject({ executable, args: ["/q", "/e", "do", "C:\\p q\\a.do"] });
  });

  it("names where SAS writes its log and listing, in the folder the run starts in", async () => {
    const executable = "C:\\Program Files\\SASHome\\SASFoundation\\9.4\\sas.exe";
    const step = await prepareOn("win32", "sas", executable, "C:\\p q", "C:\\p q\\sub\\study.sas");
    expect(step.args).toEqual([
      "-sysin",
      "C:\\p q\\sub\\study.sas",
      "-log",
      "C:\\p q\\study.log",
      "-print",
      "C:\\p q\\study.lst",
    ]);
  });

  it("concludes runs only for Stata and SAS, which leave results in files, and Stan", () => {
    const concluding = makeRunTableAdapters({
      tools: async () => new Map(),
      environment: {},
      platform: "linux",
    }).flatMap((adapter) => (adapter.concludeRun === undefined ? [] : [adapter.kind]));
    // Stan concludes to publish the program a successful run built.
    expect(concluding).toEqual(["stata", "sas", "stan"]);
  });

  it("says SAS has no Mac version instead of only that it was not found", async () => {
    const [adapter] = makeRunTableAdapters({
      tools: async () => new Map(),
      environment: {},
      platform: "darwin",
    }).filter((candidate) => candidate.kind === "sas");
    const profile = await adapter!.inspect({
      inspectedAt: "2026-11-09T00:00:00.000Z",
      platform: "darwin",
      environment: {},
    });
    expect(profile.availability).toBe("missing");
    expect(profile.detail).toMatch(/no version for Mac/u);
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

describe("a Stan model", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const folder of made.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
  });
  /** CmdStan as cmdstanpy installs it, a make on PATH, and a model in a folder whose name has a space. */
  const stanComputer = (complete = true) => {
    const folder = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient stan ")),
    );
    // CmdStan's makefiles cannot build from a path with spaces, so it lives elsewhere.
    const home = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-cmdstan-")),
    );
    made.push(folder, home);
    const root = NodePath.join(home, ".cmdstan", "cmdstan-2.40.0");
    const tools = NodePath.join(home, "tools");
    for (const directory of [NodePath.join(root, "bin"), tools])
      NodeFS.mkdirSync(directory, { recursive: true });
    const parts = complete
      ? ["makefile", "bin/stanc", "bin/stansummary", "bin/diagnose"]
      : ["bin/stanc"];
    for (const part of parts) NodeFS.writeFileSync(NodePath.join(root, part), "");
    NodeFS.writeFileSync(NodePath.join(tools, "make"), "");
    // The compiler the build would use, so a build's identity is certain and can be reused.
    NodeFS.writeFileSync(NodePath.join(tools, "g++"), "");
    const stanc = NodePath.join(root, "bin", "stanc");
    // Writes the model as its C++, or fails as stanc does on a model saying "error".
    NodeFS.writeFileSync(
      stanc,
      `#!/bin/sh\nfor a in "$@"; do case "$a" in --o=*) out="\${a#--o=}";; -*) ;; *) m="$a";; esac; done\ngrep -q error "$m" && { echo "Syntax error in '$m', line 2, column 3" >&2; exit 1; }\ncp "$m" "$out"\n`,
    );
    NodeFS.chmodSync(stanc, 0o755);
    const adapter = makeRunTableAdapters({
      tools: async () =>
        new Map([["stan", [{ ...tool("stan", "stanc", stanc), version: "2.40.0" }]]]),
      environment: { PATH: `${tools}:/usr/bin:/bin` },
      platform: "linux",
    }).find((candidate) => candidate.kind === "stan")!;
    const model = (name: string, source: string) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(folder, name)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(folder, name), source);
    };
    const run = async (relativePath: string) => {
      const context = {
        runId: ExecutionRunId.make("run"),
        projectId: "project",
        runtime: await inspect(adapter),
        source: { cwd: folder, relativePath, revision: "1" as never },
        absoluteSourcePath: NodePath.join(folder, relativePath),
        artifactStagingDirectory: NodePath.join(folder, ".staging"),
      };
      made.push(stanServerBuilds(context, "linux"));
      await adapter.prepareRun?.(context);
      return { context, prepared: adapter.prepare(context) };
    };
    return { adapter, folder, model, root, run, stanc, tools };
  };

  // The stand-in stanc is a shell script, which needs a POSIX shell; Windows has none.
  it.runIf(NodeFS.existsSync("/bin/sh"))(
    "samples through the CmdStan its stanc belongs to, and leaves no C++ in the project",
    async () => {
      const { folder, model, root, run, stanc, tools } = stanComputer();
      model("models/a.stan", "parameters {\n  real y;\n}\nmodel {\n  y ~ normal(0, 1);\n}\n");
      const { prepared } = await run("models/a.stan");
      expect(prepared.before?.map((step) => step.executable)).toEqual([
        stanc,
        NodePath.join(tools, "make"),
        expect.stringMatching(/scient-stan[\\/][^\\/]+[\\/][0-9a-f]{32}[\\/]build[\\/]a$/u),
        NodePath.join(root, "bin", "stansummary"),
      ]);
      expect(prepared.executable).toBe(NodePath.join(root, "bin", "diagnose"));
      expect(prepared.before?.[0]?.args).toContain(
        `--o=${NodePath.join(folder, ".staging", "a.hpp")}`,
      );
      expect(prepared.before?.map((step) => step.showOutput)).toEqual([
        undefined,
        "on-failure",
        "on-failure",
        undefined,
      ]);
      expect(NodeFS.readdirSync(NodePath.join(folder, "models")).sort()).toEqual([
        "a-draws",
        "a.stan",
      ]);
    },
  );

  it.runIf(NodeFS.existsSync("/bin/sh"))(
    "publishes the program it built only when the whole run succeeded",
    async () => {
      const { adapter, model, run } = stanComputer();
      model("a.stan", "parameters {\n  real y;\n}\n");
      const sampleOf = (prepared: ReturnType<typeof adapter.prepare>) =>
        prepared.before!.find((step) => step.args[0] === "sample")!.executable;
      const failed = await run("a.stan");
      const built = sampleOf(failed.prepared);
      NodeFS.writeFileSync(built, "the program");
      expect(await adapter.concludeRun?.(failed.context, 2)).toMatchObject({
        failureMessage: "Stan exited with code 2.",
      });
      const retried = await run("a.stan");
      expect(sampleOf(retried.prepared)).toBe(built);
      NodeFS.writeFileSync(built, "the program");
      expect(await adapter.concludeRun?.(retried.context, 0)).toMatchObject({
        failureMessage: null,
      });
      const published = NodePath.join(NodePath.dirname(NodePath.dirname(built)), "a");
      expect(NodeFS.readFileSync(published, "utf8")).toBe("the program");
      const later = await run("a.stan");
      expect(sampleOf(later.prepared)).toBe(published);
      expect(later.prepared.before).toHaveLength(3);
    },
  );

  it.runIf(NodeFS.existsSync("/bin/sh"))(
    "fails the run with stanc's first message when the model does not translate",
    async () => {
      const { folder, model, run } = stanComputer();
      model("a.stan", "parameters {\n  real y // error\n}\n");
      const failed = await run("a.stan").then(
        () => null,
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(AnalysisOperationError);
      expect(failed).toMatchObject({
        reason: "runtime-missing",
        message: `Stan could not translate the model: Syntax error in '${NodePath.join(folder, "a.stan")}', line 2, column 3`,
      });
    },
  );

  it("says what to install when nothing samples", async () => {
    const missing = await inspect(adapterFor("stan", []));
    expect(missing.availability).toBe("missing");
    expect(missing.detail).toMatch(/cmdstanpy\.install_cmdstan.*cmdstanr::install_cmdstan/su);
    const { adapter, stanc } = stanComputer(false);
    const alone = await inspect(adapter);
    expect(alone).toMatchObject({ availability: "missing", executablePath: stanc });
    expect(alone.detail).toContain(`Found stanc at ${stanc}, which only checks a model.`);
  });

  it("chooses a stanc inside CmdStan over one found first that only checks, unless someone chose it", async () => {
    const { stanc, tools } = stanComputer();
    const lone = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-stanc-")),
    );
    made.push(lone);
    NodeFS.writeFileSync(NodePath.join(lone, "stanc"), "");
    const adapter = makeRunTableAdapters({
      tools: async () =>
        new Map([
          [
            "stan",
            [
              tool("stan", "stanc", NodePath.join(lone, "stanc")),
              { ...tool("stan", "stanc", stanc), version: "2.40.0" },
            ],
          ],
        ]),
      environment: { PATH: tools },
      platform: "linux",
    }).find((candidate) => candidate.kind === "stan")!;
    expect(await inspect(adapter)).toMatchObject({
      availability: "available",
      executablePath: stanc,
      detail: null,
    });
    expect(await inspect(adapter, NodePath.join(lone, "stanc"))).toMatchObject({
      availability: "missing",
      executablePath: NodePath.join(lone, "stanc"),
    });
  });

  it("is ready when CmdStan and make are here", async () => {
    const { adapter } = stanComputer();
    expect(await inspect(adapter)).toMatchObject({
      availability: "available",
      version: "2.40.0",
      detail: null,
    });
  });

  it("asks for the data file a model reads before running it", () => {
    const { adapter, folder, model } = stanComputer();
    model("eight.stan", "data {\n  int<lower=0> J;\n}\nparameters {\n  real mu;\n}\n");
    const source = { cwd: folder, relativePath: "eight.stan", revision: "1" as never };
    expect(adapter.validateSource?.(source)).toBe(
      "eight.stan reads data. Put it in eight.data.json beside the model.",
    );
    model("eight.data.json", '{"J": 8}');
    expect(adapter.validateSource?.(source)).toBeNull();
  });
});
