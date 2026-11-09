// @effect-diagnostics nodeBuiltinImport:off -- gated test runs real tools on real files.
import * as NodeChildProcess from "node:child_process";
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
  stan: ["a.stan", "parameters {\n  real y;\n}\nmodel {\n  y ~ normal(0, 1);\n}\n", "R_hat"],
  lean: ["a.lean", '#eval IO.println "scient-ran"\n'],
  isabelle: [
    "a.thy",
    'theory a\n  imports Main\nbegin\nML \\<open>writeln "scient-ran"\\<close>\nend\n',
  ],
  sage: ["a.sage", 'print("scient-ran")\n'],
  // Ends as real files do, with no quit, so a tool waiting for more input would fail here.
  gap: ["a.g", 'Print("scient-ran\\n");\n'],
  macaulay2: ["a.m2", 'print "scient-ran"\n'],
  singular: ["a.sing", 'print("scient-ran");\n'],
  maxima: ["a.mac", 'print("scient-ran")$\n'],
  nextflow: ["a.nf", 'workflow {\n  println "scient-ran"\n}\n'],
  snakemake: ["a.smk", 'rule all:\n    run:\n        print("scient-ran")\n'],
  gnuplot: ["a.gp", 'print "scient-ran"\n'],
  "imagej-macro": ["a.ijm", 'print("scient-ran");\n'],
  root: ["a.C", 'void a() { printf("scient-ran\\n"); }\n'],
  idl: ["a.pro", "print, 'scient-ran'\n"],
  octave: ["a.m", 'disp("scient-ran")\n'],
  coq: ["a.v", 'Goal True.\n  idtac "scient-ran".\nAbort.\n'],
  gp: ["a.gp", 'print("scient-ran");\n'],
  haskell: ["a.hs", 'main = putStrLn "scient-ran"\n'],
  ocaml: ["a.ml", 'print_endline "scient-ran";;\n'],
  clojure: ["a.clj", '(println "scient-ran")\n'],
  "common-lisp": ["a.lisp", '(format t "scient-ran~%")\n'],
  racket: ["a.rkt", '#lang racket/base\n(displayln "scient-ran")\n'],
  ruby: ["a.rb", 'puts "scient-ran"\n'],
  lua: ["a.lua", 'print("scient-ran")\n'],
  tcl: ["a.tcl", 'puts "scient-ran"\n'],
  elixir: ["a.exs", 'IO.puts("scient-ran")\n'],
  // escript skips a file's first line, which in a real file names the module.
  erlang: ["a.erl", '-module(a).\n-export([main/1]).\nmain(_) -> io:format("scient-ran~n").\n'],
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
  scilab: ["a.sce", 'disp("scient-ran");\n'],
  minizinc: [
    "a.mzn",
    'var 1..3: x;\nconstraint x = 2;\nsolve satisfy;\noutput ["scient-ran\\n"];\n',
  ],
  // A JAGS script needs a model and data to do anything more; starting it is what Run promises.
  jags: ["a.jags", "exit\n", "JAGS"],
  // The smallest model with a saved experiment, which reports one value.
  netlogo: [
    "a.nlogo",
    'to setup\n  clear-all\n  reset-ticks\nend\nto go\n  tick\nend\n@#$#@#$#@\nGRAPHICS-WINDOW\n210\n10\n647\n448\n-1\n-1\n13.0\n1\n10\n1\n1\n1\n0\n1\n1\n1\n-16\n16\n-16\n16\n0\n0\n1\nticks\n30.0\n\n@#$#@#$#@\n@#$#@#$#@\ndefault\ntrue\n0\nPolygon -7500403 true true 150 5 40 250 150 205 260 250\n\n@#$#@#$#@\nNetLogo 6.4.0\n@#$#@#$#@\n@#$#@#$#@\n@#$#@#$#@\n<experiments>\n  <experiment name="run" repetitions="1" runMetricsEveryStep="false">\n    <setup>setup</setup>\n    <go>go</go>\n    <timeLimit steps="1"/>\n    <metric>"scient-ran"</metric>\n  </experiment>\n</experiments>\n@#$#@#$#@\n@#$#@#$#@\ndefault\n0.0\n-0.2 0 0.0 1.0\n0.0 1 1.0 0.0\n0.2 0 0.0 1.0\nlink direction\ntrue\n0\nLine -7500403 true 150 150 90 180\nLine -7500403 true 150 150 210 180\n@#$#@#$#@\n0\n@#$#@#$#@\n',
  ],
  agda: ["a.agda", "module a where\n", ""],
  // The apostrophe proves the path reaches sqlite3 whole.
  sqlite: ["o'brien.sql", ".bail on\nselect 'scient-ran';\n"],
  // Licensed, so these run only where someone has them. Both print nothing and write a log.
  stata: ["a.do", 'display "scient-ran"\n'],
  sas: ["a.sas", 'data _null_; put "scient-ran"; run;\n'],
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
  );

/** Where PATH finds a language's commands, to explain a scan that missed them. */
const whereIs = (languageId: string) => {
  const route = COMPUTE_RUN_TABLE.find((candidate) => candidate.languageId === languageId);
  const lookup = NodeProcess.platform === "win32" ? "where" : "which";
  const found = (route?.commands ?? []).flatMap(({ command }) => {
    const result = NodeChildProcess.spawnSync(lookup, [command], { encoding: "utf8" });
    return result.status === 0 ? [result.stdout.trim()] : [];
  });
  return `PATH finds [${found.join(", ")}].`;
};

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
    // Real programs, so the real clock.
    it.live.runIf(installedForTest?.includes(languageId) ?? tools.has(languageId))(
      `runs ${languageId}`,
      () =>
        Effect.gen(function* () {
          expect(
            tools.has(languageId),
            `${languageId} is installed, but the scan did not find it. ${whereIs(languageId)}`,
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
          const context = {
            runId: ExecutionRunId.make("run-table-live"),
            projectId: "live",
            runtime: profile,
            source: { cwd, relativePath: name, revision: "live" as never },
            absoluteSourcePath,
            artifactStagingDirectory: staging,
          };
          yield* Effect.promise(async () => adapter.prepareRun?.(context));
          const prepared = adapter.prepare(context);
          let output = "";
          let code: number | null = 0;
          for (const step of [...(prepared.before ?? []), prepared]) {
            const result = yield* runStep(step);
            output += `$ ${step.executable} ${step.args.join(" ")}\n${result.output}`;
            code = result.code;
            if (adapter.concludeRun === undefined) expect(result.code, output).toBe(0);
          }
          const concludeRun = adapter.concludeRun;
          if (concludeRun !== undefined) {
            const outcome = yield* Effect.promise(() => concludeRun(context, code));
            output += outcome.output.map((chunk) => chunk.text).join("");
            expect(outcome.failureMessage, output).toBeNull();
          }
          expect(output).toContain(prints);
        }).pipe(Effect.provide(Live)),
    );
  }

  // A file that imports its own project's module, which only Lake can build. Needs no network.
  it.live.runIf(installedForTest?.includes("lean") ?? tools.has("lean"))(
    "runs a Lean file in a Lake project through Lake",
    () =>
      Effect.gen(function* () {
        const adapter = adapters.find((candidate) => candidate.kind === "lean")!;
        const profile = yield* Effect.promise(() =>
          adapter.inspect({
            inspectedAt: "2026-11-09T00:00:00.000Z",
            platform: NodeProcess.platform,
            environment,
          }),
        );
        const cwd = NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-lake ")),
        );
        const write = (name: string, text: string) => {
          NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, name)), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(cwd, name), text);
        };
        write("lakefile.toml", 'name = "greet"\n\n[[lean_lib]]\nname = "Greet"\n');
        write("Greet/Basic.lean", 'def greeting := "scient-ran"\n');
        write("Notes/Use it.lean", "import Greet.Basic\n\n#eval IO.println greeting\n");
        const staging = NodePath.join(cwd, ".staging");
        NodeFS.mkdirSync(staging);
        const prepared = adapter.prepare({
          runId: ExecutionRunId.make("run-table-live"),
          projectId: "live",
          runtime: profile,
          source: { cwd, relativePath: "Notes/Use it.lean", revision: "live" as never },
          absoluteSourcePath: NodePath.join(cwd, "Notes", "Use it.lean"),
          artifactStagingDirectory: staging,
        });
        let output = "";
        for (const step of [...(prepared.before ?? []), prepared]) {
          const result = yield* runStep(step);
          output += `$ ${step.executable} ${step.args.join(" ")}\n${result.output}`;
          expect(result.code, output).toBe(0);
        }
        expect(output).toContain("scient-ran");
      }).pipe(Effect.provide(Live)),
  );

  // Eight schools with its data beside it, in a folder with a space, which make alone cannot build.
  it.live.runIf(installedForTest?.includes("stan") ?? tools.has("stan"))(
    "samples a Stan model with its data, and keeps the draws beside it",
    () =>
      Effect.gen(function* () {
        const adapter = adapters.find((candidate) => candidate.kind === "stan")!;
        const profile = yield* Effect.promise(() =>
          adapter.inspect({
            inspectedAt: "2026-11-09T00:00:00.000Z",
            platform: NodeProcess.platform,
            environment,
          }),
        );
        expect(profile.availability, profile.detail ?? "").toBe("available");
        const cwd = NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-stan ")),
        );
        const models = NodePath.join(cwd, "my models");
        NodeFS.mkdirSync(models);
        NodeFS.writeFileSync(
          NodePath.join(models, "eight schools.stan"),
          "data {\n  int<lower=0> J;\n  array[J] real y;\n  array[J] real<lower=0> sigma;\n}\nparameters {\n  real mu;\n  real<lower=0> tau;\n  vector[J] theta_tilde;\n}\ntransformed parameters {\n  vector[J] theta = mu + tau * theta_tilde;\n}\nmodel {\n  mu ~ normal(0, 5);\n  tau ~ cauchy(0, 5);\n  theta_tilde ~ normal(0, 1);\n  y ~ normal(theta, sigma);\n}\n",
        );
        const source = {
          cwd,
          relativePath: "my models/eight schools.stan",
          revision: "live" as never,
        };
        expect(adapter.validateSource?.(source)).toMatch(/reads data/u);
        NodeFS.writeFileSync(
          NodePath.join(models, "eight schools.data.json"),
          '{"J": 8, "y": [28, 8, -3, 7, -1, 1, 18, 12], "sigma": [15, 10, 16, 11, 9, 11, 10, 18]}',
        );
        expect(adapter.validateSource?.(source)).toBeNull();
        const staging = NodePath.join(cwd, ".staging");
        NodeFS.mkdirSync(staging);
        const context = {
          runId: ExecutionRunId.make("run-table-live"),
          projectId: "live",
          runtime: profile,
          source,
          absoluteSourcePath: NodePath.join(models, "eight schools.stan"),
          artifactStagingDirectory: staging,
        };
        yield* Effect.promise(async () => adapter.prepareRun?.(context));
        const prepared = adapter.prepare(context);
        let shown = "";
        for (const step of [...(prepared.before ?? []), prepared]) {
          const result = yield* runStep(step);
          expect(result.code, `$ ${step.executable} ${step.args.join(" ")}\n${result.output}`).toBe(
            0,
          );
          if (!("showOutput" in step)) shown += result.output;
        }
        expect(shown).toMatch(/^mu\s+\S+/mu);
        expect(shown).toMatch(/^theta\[8\]\s+\S+/mu);
        expect(shown).toContain("R_hat");
        expect(shown).toContain("Processing complete");
        expect(shown).not.toContain("num_warmup");
        expect(NodeFS.readdirSync(NodePath.join(models, "eight schools-draws")).sort()).toEqual([
          "eight_schools_1.csv",
          "eight_schools_2.csv",
          "eight_schools_3.csv",
          "eight_schools_4.csv",
          "summary.csv",
        ]);
        expect(NodeFS.readdirSync(models).filter((name) => name.endsWith(".hpp"))).toEqual([]);
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }).pipe(Effect.provide(Live)),
  );

  // Windows forbids double quotes in names; everything else a shell or make reads is here.
  it.live.runIf(installedForTest?.includes("stan") ?? tools.has("stan"))(
    "builds a Stan model with includes from a folder whose name a shell would run",
    () =>
      Effect.gen(function* () {
        const adapter = adapters.find((candidate) => candidate.kind === "stan")!;
        const profile = yield* Effect.promise(() =>
          adapter.inspect({
            inspectedAt: "2026-11-09T00:00:00.000Z",
            platform: NodeProcess.platform,
            environment,
          }),
        );
        expect(profile.availability, profile.detail ?? "").toBe("available");
        const cwd = NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-stan-")),
        );
        const markers = ["scient-ran-tick", "scient-ran-sub", "scient-ran-semi"];
        const name = `a \`touch ${markers[0]}\` $(touch ${markers[1]}) $HOME ${NodeProcess.platform === "win32" ? "" : '"q" '}'s' ;touch ${markers[2]}; 100%`;
        const models = NodePath.join(cwd, name, "models");
        NodeFS.mkdirSync(NodePath.join(models, "parts"), { recursive: true });
        NodeFS.mkdirSync(NodePath.join(cwd, name, "shared"));
        NodeFS.writeFileSync(
          NodePath.join(models, "m.stan"),
          "functions {\n#include parts/f.stanfunctions\n#include ../shared/g.stanfunctions\n}\nparameters {\n  real y;\n}\nmodel {\n  y ~ normal(f(), g());\n}\n",
        );
        NodeFS.writeFileSync(
          NodePath.join(models, "parts", "f.stanfunctions"),
          "real f() { return 0; }\n",
        );
        NodeFS.writeFileSync(
          NodePath.join(cwd, name, "shared", "g.stanfunctions"),
          "real g() { return 1; }\n",
        );
        const staging = NodePath.join(cwd, ".staging");
        NodeFS.mkdirSync(staging);
        const relativePath = `${name}/models/m.stan`;
        const source = { cwd, relativePath, revision: "live" as never };
        expect(adapter.validateSource?.(source)).toBeNull();
        const context = {
          runId: ExecutionRunId.make("run-table-live"),
          projectId: "live",
          runtime: profile,
          source,
          absoluteSourcePath: NodePath.join(models, "m.stan"),
          artifactStagingDirectory: staging,
        };
        yield* Effect.promise(async () => adapter.prepareRun?.(context));
        const prepared = adapter.prepare(context);
        let shown = "";
        for (const step of [...(prepared.before ?? []), prepared]) {
          const result = yield* runStep(step);
          expect(result.code, `$ ${step.executable} ${step.args.join(" ")}\n${result.output}`).toBe(
            0,
          );
          if (!("showOutput" in step)) shown += result.output;
        }
        expect(shown).toMatch(/^y\s+\S+/mu);
        expect(shown).toContain("R_hat");
        const root = NodePath.dirname(
          NodePath.dirname(NodeFS.realpathSync(profile.executablePath!)),
        );
        for (const folder of [cwd, models, root, NodeProcess.cwd()]) {
          for (const marker of markers) {
            expect(NodeFS.existsSync(NodePath.join(folder, marker)), `${marker} in ${folder}`).toBe(
              false,
            );
          }
        }
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }).pipe(Effect.provide(Live)),
  );

  // Inline includes and a symlinked folder, read as stanc reads them; the program is rebuilt only
  // when the model or an included file changed.
  it.live.runIf(installedForTest?.includes("stan") ?? tools.has("stan"))(
    "reads a Stan model's includes as stanc does, and rebuilds only when one changes",
    () =>
      Effect.gen(function* () {
        const adapter = adapters.find((candidate) => candidate.kind === "stan")!;
        const profile = yield* Effect.promise(() =>
          adapter.inspect({
            inspectedAt: "2026-11-09T00:00:00.000Z",
            platform: NodeProcess.platform,
            environment,
          }),
        );
        expect(profile.availability, profile.detail ?? "").toBe("available");
        const cwd = NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-stan-")),
        );
        const write = (name: string, text: string) => {
          NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, name)), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(cwd, name), text);
        };
        const linked = NodeProcess.platform !== "win32";
        // Through the link, `link/../g` is elsewhere/g; read as text it would be models/g.
        write("models/g.stanfunctions", "real g() { return 1; }\n");
        write("elsewhere/deep/a.stanfunctions", "real a() { return 3; }\n");
        write("elsewhere/g.stanfunctions", "real g() { return 100; }\n");
        if (linked) {
          NodeFS.symlinkSync(
            NodePath.join(cwd, "elsewhere", "deep"),
            NodePath.join(cwd, "models", "link"),
          );
        }
        write("models/f.stanfunctions", "real f() { return 2; }\n");
        const includes = linked
          ? "#include link/a.stanfunctions\n#include link/../g.stanfunctions\n"
          : "#include g.stanfunctions\nreal a() { return 3; }\n";
        write(
          "models/m.stan",
          `functions { #include f.stanfunctions\n${includes}}\n// #include missing.stanfunctions\nparameters {\n  real y;\n}\nmodel {\n  y ~ normal(0, 1);\n}\ngenerated quantities {\n  real v = f() + a() + g();\n}\n`,
        );
        const model = NodePath.join(cwd, "models", "m.stan");
        const run: { prepared: ReturnType<typeof adapter.prepare> | null } = { prepared: null };
        const program = () => {
          const make = run.prepared?.before?.[1];
          return make === undefined ? null : make.args.at(-1)!;
        };
        const sample = Effect.fn("live.stan.sample")(function* (translateFirst = true) {
          const staging = NodeFS.mkdtempSync(NodePath.join(cwd, ".staging-"));
          const context = {
            runId: ExecutionRunId.make("run-table-live"),
            projectId: "live",
            runtime: profile,
            source: { cwd, relativePath: "models/m.stan", revision: "live" as never },
            absoluteSourcePath: model,
            artifactStagingDirectory: staging,
          };
          if (translateFirst) yield* Effect.promise(async () => adapter.prepareRun?.(context));
          run.prepared = adapter.prepare(context);
          for (const step of [...(run.prepared.before ?? []), run.prepared]) {
            const result = yield* runStep(step);
            expect(
              result.code,
              `$ ${step.executable} ${step.args.join(" ")}\n${result.output}`,
            ).toBe(0);
          }
          const summary = NodeFS.readFileSync(
            NodePath.join(cwd, "models", "m-draws", "summary.csv"),
            "utf8",
          );
          return Number(/^"v",([^,]+),/mu.exec(summary)?.[1]);
        });
        expect(yield* sample()).toBe(linked ? 105 : 6);
        const built = NodeFS.statSync(program()!).mtimeMs;
        expect(yield* sample()).toBe(linked ? 105 : 6);
        expect(NodeFS.statSync(program()!).mtimeMs).toBe(built);
        write("models/f.stanfunctions", "real f() { return 20; }\n");
        expect(yield* sample()).toBe(linked ? 123 : 24);
        expect(NodeFS.statSync(program()!).mtimeMs).toBeGreaterThan(built);
        // Without the translation before the steps, the first step translates into the build.
        write("models/f.stanfunctions", "real f() { return 30; }\n");
        expect(yield* sample(false)).toBe(linked ? 133 : 34);
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }).pipe(Effect.provide(Live)),
  );
});
