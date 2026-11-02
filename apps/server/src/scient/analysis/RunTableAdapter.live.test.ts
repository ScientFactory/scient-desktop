// @effect-diagnostics nodeBuiltinImport:off -- gated test runs real tools on real files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { COMPUTE_RUN_TABLE } from "@t3tools/contracts";
import { ExecutionRunId } from "@scientfactory/execution";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import { makeNodeRuntimeDiscoveryHost } from "../compute/RuntimeDiscovery.ts";
import { groupTools, toolScanSteps } from "../compute/ToolScan.ts";
import {
  ExecutionProcess,
  layer as executionProcessLayer,
} from "../execution/LocalExecutionProcess.ts";
import { makeRunTableAdapters } from "./RunTableAdapter.ts";

/**
 * A small program in each language: its file name, its source, and what it prints. Most print
 * `scient-ran`. An empty last entry means the route only checks the file, so a clean exit is all
 * there is to see.
 */
const PROGRAMS: Readonly<Record<string, readonly [string, string, string?]>> = {
  bash: ["a.sh", 'echo "scient-ran"\n'],
  powershell: ["a.ps1", 'Write-Output "scient-ran"\n'],
  javascript: ["a.js", 'console.log("scient-ran");\n'],
  typescript: ["a.ts", 'const text: string = "scient-ran";\nconsole.log(text);\n'],
  // Reaches the math library at run time, which Linux needs named.
  c: [
    "a.c",
    '#include <math.h>\n#include <stdio.h>\nint main(int argc, char **argv) { (void)argv; puts("scient-ran"); return sqrt(argc) > 9; }\n',
  ],
  // Needs C++20, which compilers do not assume.
  cpp: [
    "a.cpp",
    '#include <concepts>\n#include <iostream>\ntemplate <std::integral T> T same(T v) { return v; }\nint main() { std::cout << "scient-ran\\n" << same(1) << "\\n"; }\n',
  ],
  fortran: ["a.f90", 'program a\n  print *, "scient-ran"\nend program a\n'],
  // `try_from` needs edition 2021, and rustc assumes 2015.
  rust: ["a.rs", 'fn main() { let _ = u32::try_from(1i64); println!("scient-ran"); }\n'],
  go: ["a.go", 'package main\nimport "fmt"\nfunc main() { fmt.Println("scient-ran") }\n'],
  java: [
    "A.java",
    'class A { public static void main(String[] a) { System.out.println("scient-ran"); } }\n',
  ],
  kotlin: ["a.kts", 'println("scient-ran")\n'],
  scala: ["a.scala", '@main def run(): Unit = println("scient-ran")\n'],
  perl: ["a.pl", 'print "scient-ran\\n";\n'],
  spss: ["a.sps", "ECHO 'scient-ran'.\n"],
  stan: ["a.stan", "parameters {\n  real y;\n}\nmodel {\n  y ~ normal(0, 1);\n}\n", ""],
  lean: ["a.lean", '#eval IO.println "scient-ran"\n'],
  isabelle: [
    "a.thy",
    'theory a\n  imports Main\nbegin\nML \\<open>writeln "scient-ran"\\<close>\nend\n',
  ],
  sage: ["a.sage", 'print("scient-ran")\n'],
  gap: ["a.g", 'Print("scient-ran\\n");\nQUIT;\n'],
  macaulay2: ["a.m2", 'print "scient-ran"\n'],
  singular: ["a.sing", 'print("scient-ran");\nquit;\n'],
  maxima: ["a.mac", 'print("scient-ran")$\n'],
  nextflow: ["a.nf", 'workflow {\n  println "scient-ran"\n}\n'],
  snakemake: ["a.smk", 'rule all:\n    run:\n        print("scient-ran")\n'],
  gnuplot: ["a.gp", 'print "scient-ran"\n'],
  "imagej-macro": ["a.ijm", 'print("scient-ran");\n'],
  root: ["a.C", 'void a() { printf("scient-ran\\n"); }\n'],
  idl: ["a.pro", "print, 'scient-ran'\nexit\n"],
  octave: ["a.m", 'disp("scient-ran")\n'],
  coq: ["a.v", 'Goal True.\n  idtac "scient-ran".\nAbort.\n'],
  gp: ["a.gp", 'print("scient-ran");\nquit\n'],
  haskell: ["a.hs", 'main = putStrLn "scient-ran"\n'],
  ocaml: ["a.ml", 'print_endline "scient-ran";;\n'],
  clojure: ["a.clj", '(println "scient-ran")\n'],
  "common-lisp": ["a.lisp", '(format t "scient-ran~%")\n'],
  racket: ["a.rkt", '#lang racket/base\n(displayln "scient-ran")\n'],
  ruby: ["a.rb", 'puts "scient-ran"\n'],
  lua: ["a.lua", 'print("scient-ran")\n'],
  tcl: ["a.tcl", 'puts "scient-ran"\n'],
  elixir: ["a.exs", 'IO.puts("scient-ran")\n'],
  erlang: ["a.erl", 'main(_) -> io:format("scient-ran~n").\n'],
  csharp: ["a.cs", 'System.Console.WriteLine("scient-ran");\n'],
  fsharp: ["a.fsx", 'printfn "scient-ran"\n'],
  zig: [
    "a.zig",
    'const std = @import("std");\npub fn main() void { std.debug.print("scient-ran\\n", .{}); }\n',
  ],
  nim: ["a.nim", 'echo "scient-ran"\n'],
  prolog: ["a.plg", ":- initialization(main, main).\nmain :- writeln('scient-ran').\n"],
  apl: ["a.apl", "⎕←'scient-ran'\n)OFF\n"],
  verilog: [
    "a.sv",
    'module a;\n  initial begin\n    $display("scient-ran");\n    $finish;\n  end\nendmodule\n',
  ],
  vhdl: [
    "a.vhd",
    'entity a is\nend entity;\narchitecture run of a is\nbegin\n  process\n  begin\n    report "scient-ran";\n    wait;\n  end process;\nend architecture;\n',
    "",
  ],
  modelica: ["a.mo", "model a\n  Real x(start = 1);\nequation\n  der(x) = -x;\nend a;\n", ""],
  scilab: ["a.sce", 'disp("scient-ran");\nexit;\n'],
  minizinc: [
    "a.mzn",
    'var 1..3: x;\nconstraint x = 2;\nsolve satisfy;\noutput ["scient-ran\\n"];\n',
  ],
  // A JAGS script needs a model and data to do anything more; starting it is what Run promises.
  jags: ["a.jags", "exit\n", "JAGS"],
  netlogo: [
    "a.nlogo",
    'to setup\n  output-print "scient-ran"\nend\n@#$#@#$#@\n@#$#@#$#@\n@#$#@#$#@\n@#$#@#$#@\n@#$#@#$#@\n@#$#@#$#@\nNetLogo 6.4.0\n@#$#@#$#@\n@#$#@#$#@\n@#$#@#$#@\n@#$#@#$#@\n@#$#@#$#@\n',
  ],
  agda: ["a.agda", "module a where\n", ""],
  // The apostrophe proves the path reaches sqlite3 whole.
  sqlite: ["o'brien.sql", ".bail on\nselect 'scient-ran';\n"],
};

/** Sold with a license, so no test computer can install them. Everything else has a program. */
const LICENSED = new Set([
  "stata",
  "sas",
  "wolfram-language",
  "maple",
  "mplus",
  "magma",
  "ampl",
  "gams",
]);

describe("the real-file programs", () => {
  it("cover every language Run starts that anyone can install", () => {
    const routes = COMPUTE_RUN_TABLE.map((route) => route.languageId);
    expect(routes.filter((id) => !LICENSED.has(id) && PROGRAMS[id] === undefined)).toEqual([]);
    expect(Object.keys(PROGRAMS).filter((id) => !routes.includes(id))).toEqual([]);
  });
});

const Live = executionProcessLayer.pipe(Layer.provideMerge(NodeServices.layer));

/** Starts one step the way Run does, and returns its exit code with everything it printed. */
const runStep = (step: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const processes = yield* ExecutionProcess;
      const handle = yield* processes.start({
        runId: ExecutionRunId.make("run-table-live"),
        executable: step.executable,
        args: step.args,
        cwd: step.cwd,
        environment: step.environment,
      });
      const output = yield* Effect.forkScoped(Stream.runCollect(handle.output));
      const code = yield* handle.exitCode;
      const chunks = yield* Fiber.join(output);
      return { code, output: Array.from(chunks, (chunk) => chunk.text).join("") };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "5 minutes",
      orElse: () => Effect.succeed({ code: -1, output: "\n[still running after 5 minutes]" }),
    }),
  );

describe.runIf(NodeProcess.env.SCIENT_TEST_RUN_TABLE === "1")("the run table", () => {
  const environment = Object.fromEntries(
    Object.entries(NodeProcess.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );
  /**
   * The languages installed for this test, when a CI job installed some. Each must be found and
   * must run, and the rest are left to the jobs that installed them. Without it, everything found.
   */
  const installedForTest = NodeProcess.env.SCIENT_TEST_RUN_TABLE_EXPECT?.split(",").filter(Boolean);
  const context = {
    platform: NodeProcess.platform,
    environment,
    homeDirectory: NodeOS.homedir(),
    host: makeNodeRuntimeDiscoveryHost(NodeProcess.platform, environment),
  };
  const tools = groupTools(toolScanSteps(context).flatMap((step) => step.run()));
  const adapters = makeRunTableAdapters({
    tools: async () => tools,
    environment,
    platform: NodeProcess.platform,
  });

  for (const [languageId, [name, source, prints = "scient-ran"]] of Object.entries(PROGRAMS)) {
    const adapter = adapters.find((candidate) => candidate.kind === languageId)!;
    it.effect.runIf(installedForTest?.includes(languageId) ?? tools.has(languageId))(
      `runs ${languageId}`,
      () =>
        Effect.gen(function* () {
          expect(
            tools.has(languageId),
            `${languageId} is installed, but the scan did not find it`,
          ).toBe(true);
          const profile = yield* Effect.promise(() =>
            adapter.inspect({
              inspectedAt: "2026-10-31T00:00:00.000Z",
              platform: NodeProcess.platform,
              environment,
            }),
          );
          expect(profile.availability).toBe("available");
          const cwd = NodeFS.realpathSync(
            NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-run-")),
          );
          const staging = NodePath.join(cwd, ".staging");
          NodeFS.mkdirSync(staging);
          const absoluteSourcePath = NodePath.join(cwd, name);
          NodeFS.writeFileSync(absoluteSourcePath, source);
          const prepared = adapter.prepare({
            runId: ExecutionRunId.make("run-table-live"),
            projectId: "live",
            runtime: profile,
            source: { cwd, relativePath: name, revision: "live" as never },
            absoluteSourcePath,
            artifactStagingDirectory: staging,
          });
          let output = "";
          for (const step of [...(prepared.before ?? []), prepared]) {
            const result = yield* runStep(step);
            output += `$ ${step.executable} ${step.args.join(" ")}\n${result.output}`;
            expect(result.code, output).toBe(0);
          }
          expect(output).toContain(prints);
        }).pipe(Effect.provide(Live)),
      // A first run can fetch a compiler, as Scala and .NET do.
      12 * 60_000,
    );
  }
});
