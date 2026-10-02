import { describe, expect, it } from "@effect/vitest";
import { beforeEach } from "vite-plus/test";

import { boundText } from "./boundedText.ts";
import {
  importedWorkLogOmissions,
  projectQuestionAnswers,
  projectWorkLog,
} from "./workLogProjection.ts";
import { activity, resetClock } from "./thread.test-fixtures.ts";

beforeEach(resetClock);

const SECRET = "sk-live-0123456789";

describe("work-log export projection", () => {
  it("keeps what an imported entry's sender left out, and counts any further cut", () => {
    const sent = {
      _tag: "tool" as const,
      id: "src-tool",
      turnId: null,
      createdAt: "2026-09-27T10:00:00.000Z",
      title: "Ran tests",
      itemType: "command_execution" as const,
      toolName: null,
      status: "completed" as const,
      command: null,
      detail: null,
      output: { text: "head\n[… 9 lines omitted …]\ntail", omittedLines: 9, omittedChars: 90 },
      changedFiles: ["a.ts"],
      omittedChangedFiles: 4,
    };
    const omissions = importedWorkLogOmissions(sent);
    expect(omissions).toEqual({
      scientExportOmissions: { output: { lines: 9, chars: 90 }, changedFiles: 4 },
    });
    expect(importedWorkLogOmissions({ ...sent, output: null, omittedChangedFiles: 0 })).toEqual({});

    const project = (output: string, extra: unknown) =>
      projectWorkLog([
        activity({
          id: "imported",
          kind: "tool.completed",
          payload: {
            title: "Ran tests",
            data: { item: { aggregatedOutput: output, changes: [{ path: "a.ts" }] } },
            scientExportOmissions: extra,
          },
        }),
      ]).entries[0];
    expect(project(sent.output.text, omissions.scientExportOmissions)).toMatchObject({
      output: sent.output,
      omittedChangedFiles: 4,
    });
    // Longer than any bounded text: bounded again, and both cuts counted.
    const long = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    const recut = project(long, { output: { lines: 9, chars: 90 } });
    expect(recut?._tag === "tool" && recut.output?.omittedLines).toBe(55 + 9);
    // Text the writer bounded by characters gains lines from its omission
    // line (46 lines become 48); exporting it again changes nothing.
    const written = boundText(
      [
        ...Array.from({ length: 23 }, (_, index) => `head ${index}`),
        "y".repeat(10_000),
        ...Array.from({ length: 22 }, (_, index) => `tail ${index}`),
      ].join("\n"),
      { headLines: 30, tailLines: 15, headChars: 6_000, tailChars: 2_000 },
    );
    expect(written.text.split("\n")).toHaveLength(48);
    expect(
      project(written.text, {
        output: { lines: written.omittedLines, chars: written.omittedChars },
      }),
    ).toMatchObject({ output: written });
    // Counts that are not whole positive numbers are ignored.
    expect(project("ok", { output: { lines: -1, chars: "x" }, changedFiles: 1.5 })).toMatchObject({
      output: { text: "ok", omittedLines: 0, omittedChars: 0 },
      omittedChangedFiles: 0,
    });
  });

  it("keeps allowlisted display fields and never provider payloads", () => {
    const { entries } = projectWorkLog([
      activity({
        id: "a1",
        kind: "tool.updated",
        turnId: "t1",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-1",
          status: "inProgress",
          title: "Ran command",
          data: { item: { command: ["bash", "-lc", "npm test"] }, env: { TOKEN: SECRET } },
        },
      }),
      activity({
        id: "a2",
        kind: "tool.completed",
        turnId: "t1",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-1",
          status: "completed",
          title: "Ran command",
          data: {
            item: { aggregatedOutput: "ok" },
            headers: { authorization: `Bearer ${SECRET}` },
          },
          providerSessionId: "native-session-1",
        },
      }),
    ]);
    expect(entries).toEqual([
      {
        _tag: "tool",
        id: "a1",
        turnId: "t1",
        createdAt: "2026-09-27T14:00:01.000Z",
        title: "Ran command",
        itemType: "command_execution",
        toolName: null,
        status: "completed",
        command: { text: 'bash -lc "npm test"', omittedLines: 0, omittedChars: 0 },
        detail: null,
        output: { text: "ok", omittedLines: 0, omittedChars: 0 },
        changedFiles: [],
        omittedChangedFiles: 0,
      },
    ]);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("native-session-1");
  });

  it("exports native tool inputs from raw history without depending on client projection", () => {
    const { entries } = projectWorkLog([
      activity({
        id: "shell",
        kind: "tool.completed",
        turnId: "t1",
        payload: {
          itemType: "dynamic_tool_call",
          toolCallId: "native-shell",
          title: "bash",
          status: "stopped",
          data: {
            toolName: "bash",
            input: { command: "printf partial" },
            rawOutput: { content: "partial" },
            env: { TOKEN: SECRET },
          },
        },
      }),
      activity({
        id: "read",
        kind: "tool.completed",
        turnId: "t1",
        payload: {
          itemType: "dynamic_tool_call",
          toolCallId: "native-read",
          title: "read",
          detail: "note.txt",
          status: "completed",
          data: {
            toolName: "read",
            input: { path: "note.txt" },
            rawOutput: { content: "file text" },
          },
        },
      }),
    ]);
    expect(entries).toMatchObject([
      {
        title: "bash",
        status: "stopped",
        command: { text: "printf partial" },
        output: { text: "partial" },
      },
      {
        title: "read",
        status: "completed",
        detail: { text: "note.txt" },
        output: { text: "file text" },
        changedFiles: [],
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain(SECRET);
  });

  it("includes nothing executable and nothing chat hides", () => {
    const { entries } = projectWorkLog([
      activity({
        id: "a1",
        kind: "approval.requested",
        payload: { requestId: "r1", command: "rm -rf /" },
      }),
      activity({
        id: "a2",
        kind: "user-input.requested",
        payload: { requestId: "q1", questions: [] },
      }),
      activity({ id: "a3", kind: "tool.started", payload: { title: "Started" } }),
      activity({ id: "a4", kind: "context-window.updated", payload: { usedTokens: 1 } }),
      activity({
        id: "a5",
        kind: "tool.updated",
        payload: { title: "Subagent", agentId: "agent-1" },
      }),
      activity({
        id: "a6",
        kind: "tool.completed",
        payload: { title: "Plan", detail: "ExitPlanMode: go" },
      }),
      activity({
        id: "a7",
        kind: "runtime.warning",
        summary: "Notice (no displayable text content)",
      }),
      activity({ id: "a8", kind: "provider.unknown", payload: { secret: SECRET } }),
    ]);
    expect(entries).toEqual([]);
  });

  it("bounds long output to a head and tail with an omission line", () => {
    const output = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
    const { entries } = projectWorkLog([
      activity({
        id: "a1",
        kind: "tool.completed",
        payload: { title: "Build", data: { rawOutput: { stdout: output } } },
      }),
    ]);
    const entry = entries[0];
    if (entry?._tag !== "tool" || entry.output === null) throw new Error("Expected output.");
    expect(entry.output.omittedLines).toBe(155);
    expect(entry.output.text).toContain("line 30\n[… 155 lines omitted …]\nline 186");
  });

  it("projects tasks, notices, compactions, failures, and the latest plan per turn", () => {
    const { entries } = projectWorkLog([
      activity({
        id: "t1",
        kind: "task.started",
        payload: { taskId: "k1", title: "Review", role: "reviewer" },
      }),
      activity({
        id: "t2",
        kind: "task.completed",
        payload: { taskId: "k1", status: "completed", summary: "Reviewed" },
      }),
      activity({
        id: "w1",
        kind: "runtime.warning",
        summary: "Slow",
        payload: { message: "Rate limited" },
      }),
      activity({ id: "c1", kind: "context-compaction", summary: "Context compacted" }),
      activity({ id: "f1", kind: "provider.turn.start.failed", summary: "Could not start" }),
      activity({
        id: "p1",
        kind: "turn.plan.updated",
        turnId: "x",
        payload: { plan: [{ step: "A", status: "pending" }] },
      }),
      activity({
        id: "p2",
        kind: "turn.plan.updated",
        turnId: "x",
        payload: {
          plan: [
            { step: "A", status: "completed" },
            { step: "B", status: "inProgress" },
          ],
        },
      }),
    ]);
    expect(entries.map((entry) => entry._tag)).toEqual([
      "task",
      "notice",
      "compaction",
      "notice",
      "plan-steps",
    ]);
    expect(entries[0]).toMatchObject({
      id: "t1",
      title: "Reviewed",
      status: "completed",
      agentRole: "reviewer",
    });
    expect(entries[1]).toMatchObject({ level: "warning", detail: { text: "Rate limited" } });
    expect(entries[3]).toMatchObject({ level: "error", title: "Could not start" });
    expect(entries[4]).toMatchObject({
      id: "p1",
      steps: [
        { step: "A", status: "completed" },
        { step: "B", status: "in-progress" },
      ],
    });
  });

  it("keeps answered questions only, with option labels", () => {
    const { questionAnswers } = projectQuestionAnswers(
      [
        activity({
          id: "q1",
          kind: "user-input.requested",
          turnId: "t1",
          payload: {
            requestId: "answered",
            questions: [
              { id: "pick", question: "Pick one", options: [{ value: "a", label: "Option A" }] },
            ],
          },
        }),
        activity({
          id: "q2",
          kind: "user-input.answer-submitted",
          turnId: "t1",
          payload: { requestId: "answered", answers: { pick: ["a"] }, attachmentsByQuestionId: {} },
        }),
        activity({
          id: "q3",
          kind: "user-input.requested",
          payload: { requestId: "pending", questions: [{ id: "x", question: "Unanswered?" }] },
        }),
      ],
      () => null,
    );
    expect(questionAnswers).toEqual([
      {
        id: "answered",
        turnId: "t1",
        createdAt: "2026-09-27T14:00:01.000Z",
        items: [{ question: "Pick one", answer: "Option A", attachments: [] }],
      },
    ]);
  });

  it("keeps answers providers report only through user-input.resolved", () => {
    const { questionAnswers } = projectQuestionAnswers(
      [
        // Codex: ids with option values, answered through item/tool/requestUserInput/answered.
        activity({
          id: "c1",
          kind: "user-input.requested",
          turnId: "t1",
          payload: {
            requestId: "codex-req",
            questions: [
              {
                id: "q_1",
                question: "Which runtime?",
                options: [{ value: "node", label: "Node.js" }],
              },
              { id: "q_2", question: "Features?" },
            ],
          },
        }),
        activity({
          id: "c2",
          kind: "user-input.resolved",
          turnId: "t1",
          payload: { requestId: "codex-req", answers: { q_1: "node", q_2: ["tests", "docs"] } },
        }),
        // Claude: answers keyed by the question text itself.
        activity({
          id: "k1",
          kind: "user-input.requested",
          turnId: "t2",
          payload: {
            requestId: "claude-req",
            questions: [{ id: "Which framework?", question: "Which framework?" }],
          },
        }),
        activity({
          id: "k2",
          kind: "user-input.resolved",
          turnId: "t2",
          payload: { requestId: "claude-req", answers: { "Which framework?": "React" } },
        }),
        // Dismissed: resolved with no answers.
        activity({
          id: "d1",
          kind: "user-input.requested",
          payload: { requestId: "gone", questions: [] },
        }),
        activity({
          id: "d2",
          kind: "user-input.resolved",
          payload: { requestId: "gone", answers: {} },
        }),
      ],
      () => null,
    );
    expect(questionAnswers).toEqual([
      {
        id: "codex-req",
        turnId: "t1",
        createdAt: "2026-09-27T14:00:01.000Z",
        items: [
          { question: "Which runtime?", answer: "Node.js", attachments: [] },
          { question: "Features?", answer: "tests, docs", attachments: [] },
        ],
      },
      {
        id: "claude-req",
        turnId: "t2",
        createdAt: "2026-09-27T14:00:03.000Z",
        items: [{ question: "Which framework?", answer: "React", attachments: [] }],
      },
    ]);
  });

  it("combines resolved answers with attachments from answer-submitted", () => {
    const attachment = {
      localId: "thread-1-file",
      kind: "file" as const,
      name: "data.csv",
      mimeType: "text/csv",
      sizeBytes: 3,
      pastedText: false,
      available: true,
    };
    const { questionAnswers } = projectQuestionAnswers(
      [
        activity({
          id: "a1",
          kind: "user-input.requested",
          turnId: "t1",
          payload: { requestId: "r", questions: [{ id: "file", question: "Upload data" }] },
        }),
        activity({
          id: "a2",
          kind: "user-input.answer-submitted",
          turnId: "t1",
          payload: {
            requestId: "r",
            answers: { file: "attached" },
            attachmentsByQuestionId: { file: [{ id: "thread-1-file" }] },
          },
        }),
        activity({
          id: "a3",
          kind: "user-input.resolved",
          turnId: "t1",
          payload: { requestId: "r", answers: { file: "attached" } },
        }),
      ],
      () => attachment,
    );
    expect(questionAnswers).toEqual([
      {
        id: "r",
        turnId: "t1",
        createdAt: "2026-09-27T14:00:01.000Z",
        items: [{ question: "Upload data", answer: "attached", attachments: [attachment] }],
      },
    ]);
  });
});
