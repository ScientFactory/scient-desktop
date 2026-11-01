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
import { makeRunTableAdapters } from "./RunTableAdapter.ts";

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
      { executablePath: "/usr/bin/java", label: "java", version: null },
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
    expect(step.args).toEqual(["-bail", ":memory:", ".read '/project/a.sql'"]);
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
