import { assert, it } from "@effect/vitest";

import { OmpToolRows } from "./OmpToolRows.ts";

const redact = (text: string) => text.replaceAll("secret", "[REDACTED]");
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

it("reports a finished command's success as exit code 0 and keeps the arguments of its first frame", () => {
  const rows = new OmpToolRows(redact);
  rows.row("c1", "bash", {
    input: { command: "echo secret" },
    data: undefined,
    output: undefined,
    status: "running",
  });
  assert.deepEqual(
    rows.row("c1", "bash", {
      input: undefined,
      data: text("[REDACTED]"),
      output: "secret",
      status: "completed",
    }),
    { type: "command_execution", input: "echo [REDACTED]", output: "[REDACTED]", exitCode: 0 },
  );
});

it("keeps the end of a running command's output within the running bound", () => {
  const row = new OmpToolRows(redact).row("c1", "bash", {
    input: { command: "make" },
    data: undefined,
    output: `${"a".repeat(8192)}last line`,
    status: "running",
  });
  assert.ok(row?.type === "command_execution");
  assert.isAtMost(Buffer.byteLength(row.output ?? ""), 4096 + Buffer.byteLength("…\n"));
  assert.isTrue(row.output?.endsWith("last line"));
  assert.isUndefined(row.exitCode);
});

it("shows every file of a multi-file edit with one diff", () => {
  const row = new OmpToolRows(redact).row("e1", "edit", {
    input: { path: "a.ts" },
    data: {
      details: {
        perFileResults: [
          { path: "/w/a.ts", oldText: "1\n", newText: "2\n" },
          { path: "/w/c.ts", sourcePath: "/w/b.ts", oldText: "x\n", newText: "y\n" },
        ],
      },
    },
    output: undefined,
    status: "completed",
  });
  assert.ok(row?.type === "file_change");
  assert.equal(row.fileName, "/w/a.ts");
  assert.deepEqual(row.changes, [
    { operation: "edit", path: "/w/a.ts" },
    { operation: "edit", path: "/w/c.ts", oldPath: "/w/b.ts" },
  ]);
  assert.include(row.diffStr, "--- /w/a.ts\n+++ /w/a.ts");
  assert.include(row.diffStr, "--- /w/b.ts\n+++ /w/c.ts");
});

it("shows why a failed edit failed", () => {
  assert.deepEqual(
    new OmpToolRows(redact).row("e1", "edit", {
      input: { path: "a.ts" },
      data: { details: { diff: "", errorKind: "stale_tag" } },
      output: "Edit refused: stale secret",
      status: "failed",
    }),
    { type: "file_change", fileName: "a.ts", diffStr: "Edit refused: stale [REDACTED]" },
  );
});

it("shows a written file's new content", () => {
  assert.deepEqual(
    new OmpToolRows(redact).row("w1", "write", {
      input: { path: "notes.md", content: "secret notes" },
      data: { details: { resolvedPath: "/w/notes.md" } },
      output: "Wrote notes.md",
      status: "completed",
    }),
    { type: "file_change", fileName: "/w/notes.md", newStr: "[REDACTED] notes" },
  );
});

it("leaves a finished search without sources and an edit without snapshots generic", () => {
  const rows = new OmpToolRows(redact);
  assert.isUndefined(
    rows.row("s1", "web_search", {
      input: { query: "dna" },
      data: { details: { response: { sources: [] }, error: "No web search model configured" } },
      output: "No web search model configured",
      status: "failed",
    }),
  );
  assert.isUndefined(
    rows.row("e1", "edit", {
      input: { path: "a.ts" },
      data: { details: { path: "/w/a.ts", diff: "-1|old", snapshotsPruned: true } },
      output: "Updated a.ts",
      status: "completed",
    }),
  );
});

it("leaves other tools, and writes to agent devices, as generic rows", () => {
  const rows = new OmpToolRows(redact);
  assert.isUndefined(
    rows.row("r1", "read", {
      input: { path: "a.ts" },
      data: undefined,
      output: undefined,
      status: "running",
    }),
  );
  assert.isUndefined(
    rows.row("w1", "write", {
      input: { path: "xd://generate_image", content: "{}" },
      data: undefined,
      output: undefined,
      status: "running",
    }),
  );
});
