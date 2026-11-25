// @effect-diagnostics nodeBuiltinImport:off -- exercise real project containment on the host filesystem.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { normalizeKernelDiagnostic, normalizePythonDiagnostic } from "./PythonDiagnostic.ts";

const CONTEXT = {
  projectRoot: "/project",
  submittedSource: { relativePath: "analysis.py", startLine: 0 },
} as const;
const normalize = (report: Parameters<typeof normalizePythonDiagnostic>[0]) =>
  normalizePythonDiagnostic(report, CONTEXT);

describe("python diagnostic normalization", () => {
  it("preserves a clean traceback", () => {
    const diagnostics = normalize({
      name: "ValueError",
      value: "invalid literal for int()",
      traceback: [
        '  File "<string>", line 1, in <module>',
        "    int('abc')",
        "ValueError: invalid literal for int()",
      ],
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.errorName).toBe("ValueError");
    expect(diagnostics[0]!.message).toBe("invalid literal for int()");
    expect(diagnostics[0]!.traceback).toEqual([
      '  File "<string>", line 1, in <module>',
      "    int('abc')",
      "ValueError: invalid literal for int()",
    ]);
    expect(diagnostics[0]!.frames).toEqual([]);
  });

  it("strips ANSI colour codes from every field", () => {
    const diagnostics = normalize({
      name: "\u001B[31mTypeError\u001B[0m",
      value: "\u001B[31munsupported operand\u001B[0m",
      traceback: ['\u001B[31m  File "x", line 1\u001B[0m', "\u001B[32m  x + 1\u001B[0m"],
    });
    expect(diagnostics[0]!.errorName).toBe("TypeError");
    expect(diagnostics[0]!.message).toBe("unsupported operand");
    expect(diagnostics[0]!.traceback).toEqual(['  File "x", line 1', "  x + 1"]);
  });

  it("strips OSC and other C1 control sequences", () => {
    const diagnostics = normalize({
      name: "Error",
      value: "msg",
      traceback: ["\u0007normal\u0000text\u000B"],
    });
    expect(diagnostics[0]!.traceback).toEqual(["normaltext"]);
  });

  it("truncates error name to 256 bytes on a Unicode boundary", () => {
    const longName = "E" + "\u00e9".repeat(200); // each é is 2 bytes in UTF-8
    const diagnostics = normalize({
      name: longName,
      value: "v",
      traceback: [],
    });
    const encoded = new TextEncoder().encode(diagnostics[0]!.errorName);
    expect(encoded.byteLength).toBeLessThanOrEqual(256);
  });

  it("truncates error value to 16 KiB on a Unicode boundary", () => {
    const longValue = "x".repeat(20_000);
    const diagnostics = normalize({
      name: "E",
      value: longValue,
      traceback: [],
    });
    const encoded = new TextEncoder().encode(diagnostics[0]!.message);
    expect(encoded.byteLength).toBeLessThanOrEqual(16384);
  });

  it("limits traceback to 200 lines", () => {
    const diagnostics = normalize({
      name: "E",
      value: "v",
      traceback: Array(250).fill("line"),
    });
    expect(diagnostics[0]!.traceback).toHaveLength(200);
  });

  it("drops empty traceback lines after stripping", () => {
    const diagnostics = normalize({
      name: "E",
      value: "v",
      traceback: ["real line", "\u001B[31m\u001B[0m", "   ", "another line"],
    });
    expect(diagnostics[0]!.traceback).toEqual(["real line", "   ", "another line"]);
  });

  it("spends the line limit on lines that say something", () => {
    // A traceback that opens with two hundred colour resets still has to show
    // the frames that follow them.
    const traceback = [...Array<string>(200).fill("\u001B[0m"), "real line", "another line"];
    const diagnostics = normalize({ name: "E", value: "v", traceback });
    expect(diagnostics[0]!.traceback).toEqual(["real line", "another line"]);
  });

  it("truncates safely on a multi-byte character boundary", () => {
    // 🎉 is 4 bytes in UTF-8.  Truncating at 5 bytes must not produce a
    // replacement character or a broken string.
    const diagnostics = normalize({
      name: "E",
      value: "v",
      traceback: ["🎉".repeat(2000)],
    });
    const line = diagnostics[0]!.traceback[0]!;
    const encoded = new TextEncoder().encode(line);
    expect(encoded.byteLength).toBeLessThanOrEqual(4096);
    // No U+FFFD replacement character from incomplete decoding.
    expect(line).not.toContain("\uFFFD");
  });

  it("maps each retained execution to its own document range, never the current submission", () => {
    const diagnostics = normalizePythonDiagnostic(
      {
        name: "ValueError",
        value: "bad value",
        traceback: [
          "File <scient-compute-source:61:1>:2, in calculate()\n----> 2 calculate()",
          '  File "<scient-compute-source:62:2>", line 4, in <module>',
        ],
      },
      {
        projectRoot: "/project",
        submittedSource: { relativePath: "current.py", startLine: 100 },
        executionSources: new Map([
          ["a", { relativePath: "src/model.py", startLine: 20, lineCount: 5 }],
          ["b", { relativePath: "other.py", startLine: 40, lineCount: 5 }],
        ]),
      },
    );

    expect(diagnostics[0]!.frames).toEqual([
      {
        relativePath: "src/model.py",
        line: 22,
        column: null,
        functionName: "calculate()",
      },
      {
        relativePath: "other.py",
        line: 44,
        column: null,
        functionName: "<module>",
      },
    ]);
    expect(diagnostics[0]!.traceback).toEqual([
      "File src/model.py:22, in calculate()\n----> 2 calculate()",
      '  File "other.py", line 44, in <module>',
    ]);
  });

  it("keeps unknown, evicted, malformed and out-of-range sources readable without invented navigation", () => {
    const traceback = [
      'File "<scient-compute-source:63:1>", line 2',
      'File "<scient-compute-source:6:1>", line 2',
      'File "<scient-compute-source:61:1>", line 9',
      'File "<scient-compute-source:61:1>", line 0',
      'File "<scient-compute-source>", line 2',
      'File "<string>", line 2',
      "Cell In[7], line 2, in retained()",
    ];
    const diagnostics = normalizePythonDiagnostic(
      { name: "ValueError", value: "old source", traceback },
      {
        ...CONTEXT,
        executionSources: new Map([
          ["a", { relativePath: "original.py", startLine: 10, lineCount: 2 }],
        ]),
      },
    );
    expect(diagnostics[0]!.frames).toEqual([]);
    expect(diagnostics[0]!.traceback).toEqual(traceback);
  });

  it("keeps only project-local file frames and deduplicates locations", () => {
    const diagnostics = normalizePythonDiagnostic(
      {
        name: "RuntimeError",
        value: "failure",
        traceback: [
          '  File "/project/src/model.py", line 8, in run',
          '  File "/project/src/model.py", line 8, in run',
          '  File "/opt/python/site-packages/library.py", line 12, in call',
          "  File src/helper.py:4, in helper",
        ],
      },
      CONTEXT,
    );

    expect(diagnostics[0]!.frames).toEqual([
      { relativePath: "src/model.py", line: 8, column: null, functionName: "run" },
      { relativePath: "src/helper.py", line: 4, column: null, functionName: "helper" },
    ]);
  });

  it("does not invent a location when no submitted document exists", () => {
    const diagnostics = normalizePythonDiagnostic(
      {
        name: "RuntimeError",
        value: "failure",
        traceback: ['  File "<string>", line 1, in <module>'],
      },
      { projectRoot: "/project", submittedSource: null },
    );

    expect(diagnostics[0]!.frames).toEqual([]);
  });
});

it("keeps R syntax positions and sourced frames inside the project", () => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "r-diagnostic-"));
  try {
    const projectRoot = NodePath.join(scratch, "project");
    NodeFS.mkdirSync(projectRoot);
    const script = NodePath.join(projectRoot, "syntax.R");
    const helper = NodePath.join(projectRoot, "helper.R");
    const outside = NodePath.join(scratch, "outside.R");
    for (const file of [script, helper, outside]) NodeFS.writeFileSync(file, "code");
    const context = { projectRoot, submittedSource: null };
    expect(
      normalizeKernelDiagnostic(
        {
          name: "",
          value: `${script}:3:5: unexpected symbol`,
          traceback: [],
        },
        context,
        "r",
      )[0]?.frames,
    ).toMatchObject([{ relativePath: "syntax.R", line: 3, column: 5 }]);
    expect(
      normalizeKernelDiagnostic(
        {
          name: "",
          value: "Error in `helper()`:\n! bad value\nat helper.R:2:3",
          traceback: [`at ${outside}:4:1`, "at missing.R:2:3"],
        },
        context,
        "r",
      )[0],
    ).toMatchObject({
      message: "Error in `helper()`:\nbad value",
      frames: [{ relativePath: "helper.R", line: 2, column: 3 }],
    });
  } finally {
    NodeFS.rmSync(scratch, { force: true, recursive: true });
  }
});

it("links Julia's function and top-level frames only to real project files", () => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "julia-diagnostic-"));
  try {
    const projectRoot = NodePath.join(scratch, "project");
    NodeFS.mkdirSync(projectRoot);
    const file = NodePath.join(projectRoot, "analysis.jl");
    const external = NodePath.join(scratch, "error.jl");
    NodeFS.writeFileSync(file, 'function fail()\n  error("boom")\nend\nfail()\n');
    NodeFS.writeFileSync(external, "");
    const [diagnostic] = normalizeKernelDiagnostic(
      {
        name: "LoadError",
        value: "boom",
        traceback: [
          "  @ Base ./error.jl:44",
          `  @ Statistics ${external}:195`,
          "  @ Main <scient-compute-source:61:1>:2",
          "  @ <scient-compute-source:61:1>:4",
          "  @ Main ./In[9]:1",
          `  @ Main ${NodePath.join(projectRoot, "missing.jl")}:7`,
          `  @ Main ${file}:3`,
        ],
      },
      {
        projectRoot,
        submittedSource: null,
        executionSources: new Map([
          ["a", { relativePath: "analysis.jl", startLine: 0, lineCount: 4 }],
        ]),
      },
      "julia",
    );
    expect(diagnostic?.frames.map(({ relativePath, line }) => [relativePath, line])).toEqual([
      ["analysis.jl", 2],
      ["analysis.jl", 4],
      ["analysis.jl", 3],
    ]);
    expect(diagnostic?.traceback).toContain("  @ Main analysis.jl:2");
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
});
