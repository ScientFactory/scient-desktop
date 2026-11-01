// @effect-diagnostics nodeBuiltinImport:off -- gated test runs real tools on real files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { ExecutionRunId } from "@scientfactory/execution";
import { describe, expect, it } from "vite-plus/test";

import { makeNodeRuntimeDiscoveryHost } from "../compute/RuntimeDiscovery.ts";
import { groupTools, toolScanSteps } from "../compute/ToolScan.ts";
import { makeRunTableAdapters } from "./RunTableAdapter.ts";

/** A small program in each language. It prints the same line, so one check covers them all. */
const PROGRAMS: Readonly<Record<string, readonly [string, string]>> = {
  bash: ["a.sh", 'echo "scient-ran"\n'],
  powershell: ["a.ps1", 'Write-Output "scient-ran"\n'],
  javascript: ["a.js", 'console.log("scient-ran");\n'],
  typescript: ["a.ts", 'const text: string = "scient-ran";\nconsole.log(text);\n'],
  c: ["a.c", '#include <stdio.h>\nint main(void) { puts("scient-ran"); return 0; }\n'],
  cpp: ["a.cpp", '#include <iostream>\nint main() { std::cout << "scient-ran\\n"; }\n'],
  fortran: ["a.f90", 'program a\n  print *, "scient-ran"\nend program a\n'],
  rust: ["a.rs", 'fn main() { println!("scient-ran"); }\n'],
  go: ["a.go", 'package main\nimport "fmt"\nfunc main() { fmt.Println("scient-ran") }\n'],
  java: [
    "A.java",
    'class A { public static void main(String[] a) { System.out.println("scient-ran"); } }\n',
  ],
  perl: ["a.pl", 'print "scient-ran\\n";\n'],
  ruby: ["a.rb", 'puts "scient-ran"\n'],
  lua: ["a.lua", 'print("scient-ran")\n'],
  tcl: ["a.tcl", 'puts "scient-ran"\n'],
  octave: ["a.m", 'disp("scient-ran")\n'],
  gnuplot: ["a.plt", 'print "scient-ran"\n'],
  haskell: ["a.hs", 'main = putStrLn "scient-ran"\n'],
  ocaml: ["a.ml", 'print_endline "scient-ran";;\n'],
  racket: ["a.rkt", '#lang racket/base\n(displayln "scient-ran")\n'],
  zig: [
    "a.zig",
    'const std = @import("std");\npub fn main() void { std.debug.print("scient-ran\\n", .{}); }\n',
  ],
  nim: ["a.nim", 'echo "scient-ran"\n'],
  elixir: ["a.exs", 'IO.puts("scient-ran")\n'],
  csharp: ["a.cs", 'System.Console.WriteLine("scient-ran");\n'],
};

describe.runIf(NodeProcess.env.SCIENT_TEST_RUN_TABLE === "1")("the run table", () => {
  const environment = Object.fromEntries(
    Object.entries(NodeProcess.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );
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

  for (const [languageId, [name, source]] of Object.entries(PROGRAMS)) {
    const adapter = adapters.find((candidate) => candidate.kind === languageId)!;
    it.runIf(tools.has(languageId))(
      `runs ${languageId}`,
      async () => {
        const profile = await adapter.inspect({
          inspectedAt: "2026-10-31T00:00:00.000Z",
          platform: NodeProcess.platform,
          environment,
        });
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
          const result = NodeChildProcess.spawnSync(step.executable, step.args, {
            cwd: step.cwd,
            env: step.environment,
            encoding: "utf8",
            timeout: 120_000,
          });
          output += `${result.stdout ?? ""}${result.stderr ?? ""}`;
          expect(result.status, output).toBe(0);
        }
        expect(output).toContain("scient-ran");
      },
      180_000,
    );
  }
});
