import { ExecutionRunId } from "@scientfactory/execution";
import {
  COMPUTE_LANGUAGE_CATALOG,
  COMPUTE_RUN_TABLE,
  computeRunnableTools,
  computeRunRouteForPath,
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
      before: [{ executable: "/usr/bin/gcc", args: ["/project/a.c", "-o", "/staging/program"] }],
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
