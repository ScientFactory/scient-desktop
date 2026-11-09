// @effect-diagnostics nodeBuiltinImport:off -- writes the files Stata and SAS leave behind.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import type { AnalysisRunContext } from "@scientfactory/analysis";
import { ExecutionRunId } from "@scientfactory/execution";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readBatchLog, sasMessages, stataError } from "./batchLogOutput.ts";
import { makeRunTableAdapters } from "./RunTableAdapter.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

/** A project in a folder with a space, its file in a subfolder with a space. */
async function project(languageId: "stata" | "sas", relativePath: string, source = "") {
  const cwd = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient batch logs ")),
  );
  folders.push(cwd);
  const absoluteSourcePath = NodePath.join(cwd, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(absoluteSourcePath), { recursive: true });
  NodeFS.writeFileSync(absoluteSourcePath, source);
  const adapter = makeRunTableAdapters({
    tools: async () => new Map([[languageId, []]]),
    environment: {},
    platform: NodeProcess.platform,
  }).find((candidate) => candidate.kind === languageId)!;
  const runtime = await adapter.inspect({
    inspectedAt: "2026-11-09T00:00:00.000Z",
    platform: NodeProcess.platform,
    environment: {},
    customExecutablePath: `/opt/${languageId}`,
  });
  const context: AnalysisRunContext = {
    runId: ExecutionRunId.make("run"),
    projectId: "project",
    runtime,
    source: { cwd, relativePath, revision: "1" as never },
    absoluteSourcePath,
    artifactStagingDirectory: NodePath.join(cwd, ".staging"),
  };
  const write = (name: string, text: string | Buffer) =>
    NodeFS.writeFileSync(NodePath.join(cwd, name), text);
  /** The run: the tool writes its files, then exits with a code. */
  const run = async (tool: () => void, exitCode: number) => {
    await adapter.prepareRun!(context);
    tool();
    return adapter.concludeRun!(context, exitCode);
  };
  return { cwd, write, run };
}

const shown = (outcome: { readonly output: ReadonlyArray<{ readonly text: string }> }) =>
  outcome.output.map((chunk) => chunk.text).join("");

const stataLog = (...lines: ReadonlyArray<string>) =>
  [". do analysis.do", "", ...lines, "", "end of do-file", ""].join("\n");

describe("a Stata run", () => {
  it("shows its log as the result, without what batch mode wraps around it", async () => {
    const { write, run } = await project("stata", "code dir/my analysis.do");
    const outcome = await run(
      () => write("my analysis.log", stataLog('. display "scient-ran"', "scient-ran")),
      0,
    );
    expect(outcome.failureMessage).toBeNull();
    expect(shown(outcome)).toBe('. display "scient-ran"\nscient-ran\n');
    expect(outcome.writtenFiles).toEqual(["my analysis.log"]);
  });

  it("fails at r(#) although Stata exits 0, naming the error and its line", async () => {
    const { write, run } = await project("stata", "a.do", 'display "one"\nuse nothere\n');
    const log = stataLog(". use nothere", "file nothere.dta not found", "r(601);") + "r(601);\n";
    const outcome = await run(() => write("a.log", log), 0);
    expect(outcome.failureMessage).toBe("file nothere.dta not found (r(601))");
    expect(outcome.diagnostics).toMatchObject([
      { code: "r(601)", message: "file nothere.dta not found", relativePath: "a.do", line: 2 },
    ]);
    expect(shown(outcome)).toContain("end of do-file");
  });

  it("does not fail on an error the do-file captured", async () => {
    const { write, run } = await project("stata", "a.do");
    const log = stataLog(
      ". capture noisily error 198",
      "invalid syntax",
      '. display "after"',
      "after",
    );
    expect((await run(() => write("a.log", log), 0)).failureMessage).toBeNull();
  });

  it("never shows an earlier run's log as this one's", async () => {
    const { write, run } = await project("stata", "a.do");
    write("a.log", stataLog("old result"));
    const failed = await run(() => {}, 1);
    expect(failed).toMatchObject({ output: [], failureMessage: "Stata exited with code 1." });
    const silent = await run(() => {}, 0);
    expect(silent.failureMessage).toMatch(
      /^Stata did not write a\.log in .+, so there is nothing/u,
    );
  });

  it("finds a log written beside the do-file", async () => {
    const { write, run } = await project("stata", "sub/a.do");
    const outcome = await run(() => write("sub/a.log", stataLog("1")), 0);
    expect(outcome).toMatchObject({ failureMessage: null, writtenFiles: ["sub/a.log"] });
  });

  it("reads an older Stata's Windows-1252 log", async () => {
    const { write, run } = await project("stata", "a.do");
    const outcome = await run(() => write("a.log", Buffer.from(stataLog("Müller"), "latin1")), 0);
    expect(shown(outcome)).toBe("Müller\n");
  });

  it("keeps a huge log's start and end, and still sees the error at its end", async () => {
    const { write, run } = await project("stata", "a.do");
    const rows = Array.from({ length: 120_000 }, (_, index) => `row ${index} ${"x".repeat(40)}`);
    const log = stataLog(...rows, ". exit 459", "r(459);");
    const outcome = await run(() => write("a.log", log), 0);
    expect(Buffer.byteLength(shown(outcome))).toBeLessThan(3.1 * 1024 * 1024);
    expect(shown(outcome)).toMatch(/row 0 [\s\S]*… [\d.]+ MB more of a\.log …[\s\S]*row 119999 /u);
    expect(outcome.diagnostics[0]?.code).toBe("r(459)");
  });
});

describe("a SAS run", () => {
  const listing = "\f                     The SAS System\r\n\r\nObs    name\r\n  1    Ada\r\n";
  const log = (...lines: ReadonlyArray<string>) =>
    ["NOTE: SAS (r) Proprietary Software 9.4", ...lines, "NOTE: The SAS System used:"].join("\r\n");

  it("shows its listing as the result, and points at both files", async () => {
    const { write, run } = await project("sas", "code dir/my study.sas");
    const outcome = await run(() => {
      write("my study.lst", listing);
      write("my study.log", log());
    }, 0);
    expect(outcome.failureMessage).toBeNull();
    expect(shown(outcome)).toBe("                     The SAS System\n\nObs    name\n  1    Ada\n");
    expect(outcome.writtenFiles).toEqual(["my study.lst", "my study.log"]);
  });

  it("shows the log when the program printed no listing", async () => {
    const { write, run } = await project("sas", "a.sas");
    const outcome = await run(
      () => write("a.log", log("NOTE: The data set WORK.X has 2 rows.")),
      0,
    );
    expect(shown(outcome)).toContain("WORK.X has 2 rows");
  });

  it("succeeds with warnings, and shows them after the result", async () => {
    const { write, run } = await project("sas", "a.sas");
    const outcome = await run(() => {
      write("a.lst", listing);
      write("a.log", log("WARNING: Variable x is", "         uninitialized."));
    }, 1);
    expect(outcome.failureMessage).toBeNull();
    expect(outcome.output.at(-1)).toEqual({
      stream: "stderr",
      text: "WARNING: Variable x is uninitialized.\n",
    });
  });

  it("fails on errors, naming each one", async () => {
    const { write, run } = await project("sas", "a.sas");
    const errors = log(
      "ERROR: File WORK.NOTHERE.DATA does not exist.",
      "           180",
      "ERROR 180-322: Statement is not valid or it is used out of proper order.",
    );
    const outcome = await run(() => write("a.log", errors), 2);
    expect(outcome.failureMessage).toBe("File WORK.NOTHERE.DATA does not exist.");
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([null, "180-322"]);
  });

  it("says what an ABORT means", async () => {
    const { write, run } = await project("sas", "a.sas");
    const outcome = await run(() => write("a.log", log()), 4);
    expect(outcome.failureMessage).toBe("The program stopped at an ABORT RETURN statement.");
  });

  it("never shows an earlier run's files when SAS cannot start", async () => {
    const { write, run } = await project("sas", "a.sas");
    write("a.lst", "old listing\n");
    write("a.log", "old log\n");
    const outcome = await run(() => {}, 6);
    expect(outcome).toMatchObject({ output: [], failureMessage: "SAS could not start." });
  });
});

describe("reading a log", () => {
  it("knows a Stata error only when it ends the log", () => {
    expect(stataError(". display 1\n1\n\nend of do-file\n")).toBeNull();
    expect(stataError(". use x\nfile x.dta not found\nr(601);\n\nend of do-file\n")).toEqual({
      code: 601,
      message: "file x.dta not found",
      command: "use x",
    });
  });

  it("joins a SAS message with the lines that continue it", () => {
    expect(sasMessages("ERROR: one\n       two\n12   data x;\nERROR: three", "ERROR")).toEqual([
      { code: null, message: "one two" },
      { code: null, message: "three" },
    ]);
  });

  it("never cuts a character in two", async () => {
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-batch-read-"));
    folders.push(folder);
    const file = NodePath.join(folder, "a.log");
    NodeFS.writeFileSync(file, `${"é".repeat(40)}\n`.repeat(100));
    const { text } = await readBatchLog(file, { head: 101, tail: 101 });
    expect(text).not.toContain("�");
    expect(text).toContain("é");
  });
});
