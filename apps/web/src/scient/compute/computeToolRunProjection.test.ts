import { expect, it } from "vite-plus/test";

import { isComputeRunTool, readComputeToolActivity } from "./computeToolRunProjection";

it("projects a provider's retained Compute run without its transport metadata", () => {
  expect(isComputeRunTool("mcp__scient__scient_compute_run")).toBe(true);
  expect(isComputeRunTool("mcp__another_server__scient_compute_run")).toBe(false);
  const result = readComputeToolActivity({ code: "print(recall)" }, [
    {
      type: "text",
      text: JSON.stringify({
        message: "Tool completed",
        content: [{ type: "image", _meta: { path: "~/.claude/projects/tool-results/figure.png" } }],
        structuredContent: {
          session: { session: "session-a" },
          run: { run: "run-a", status: "succeeded", output: "0.8" },
        },
        _meta: { path: "~/.claude/projects/tool-results/result.json" },
      }),
    },
  ]);
  expect(result).toEqual({
    code: "print(recall)",
    file: undefined,
    language: undefined,
    session: "session-a",
    run: "run-a",
    status: "succeeded",
    output: "0.8",
  });
  expect(
    readComputeToolActivity(
      { path: "/Users/example/.claude/projects/script.py" },
      { truncated: true, summary: "{unterminated json" },
    ),
  ).toMatchObject({ file: undefined, output: undefined });
});

it("keeps the tool failure message and omits a provider staging path", () => {
  const received = readComputeToolActivity(
    {},
    {
      isError: true,
      content: [
        {
          type: "text",
          text: "Choose a matching session. ~/.claude/projects/sample/tool-results/detail.json",
        },
      ],
    },
  );
  expect(received.failureReason).toBe("Choose a matching session. [provider path]");
  expect(readComputeToolActivity({}, '{"_meta": "private"}')).not.toHaveProperty("failureReason");
});

it("shows proposed setup before a reply and the recorded values afterward", () => {
  const input = { path: "threshold.R", parameters: { threshold: 0.7, checks: [true, false] } };
  expect(readComputeToolActivity(input, null).parameters).toEqual({
    threshold: "0.7",
    checks: "[true,false]",
  });
  expect(
    readComputeToolActivity(input, { run: { run: "run-a", parameters: { threshold: "0.6" } } })
      .parameters,
  ).toEqual({ threshold: "0.6" });
});
