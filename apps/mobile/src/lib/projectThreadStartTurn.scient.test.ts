import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { serializeComposerCitation } from "@t3tools/shared/composerCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectThreadStartTurnInput,
  deriveThreadTitleFromPrompt,
  deriveThreadTitleSeed,
} from "./projectThreadStartTurn";

describe("project thread title", () => {
  it("normalizes context around a file quote without dropping its captured text", () => {
    const citation = serializeComposerCitation({
      kind: "file",
      version: 1,
      environmentId: EnvironmentId.make("source-environment"),
      threadId: ThreadId.make("source-thread"),
      cwd: "/workspace",
      path: "paper.md",
      revision: `sha256:${"a".repeat(64)}`,
      origin: "saved",
      sourceStart: 0,
      sourceEnd: 12,
      startLine: 1,
      endLine: 1,
      from: 0,
      to: 12,
      text: "Study result",
      prefix: "",
      suffix: "",
    });
    const text = `![photo.png](t3-context://v1/image/photo) ${citation}`;
    expect(deriveThreadTitleFromPrompt(text)).toBe("Study result");
    expect(deriveThreadTitleSeed({ text, attachments: [] })).toBe("Study result");
  });

  // Upstream deleted this row in its snap; it is the only guard of the mobile length limit.
  // regression: b20f55248d fix(clients): image threads use readable titles (#19822)
  it("normalizes draft and queued titles while keeping the mobile length limit", () => {
    expect(
      deriveThreadTitleFromPrompt(
        "![photo.png](t3-context://v1/image/photo) Fix [src/app.ts](t3-context://v1/mention/source) so the sidebar remains readable when a thread starts with an image",
      ),
    ).toBe("Fix src/app.ts so the sidebar remains readable when a thread starts w...");
  });
});

describe("new thread start command", () => {
  it("carries the Scient skills selected in the prompt", () => {
    const input = buildProjectThreadStartTurnInput({
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      threadId: "new-thread",
      commandId: "command",
      messageId: "message",
      createdAt: "2026-09-06T00:00:00Z",
      text: "$pdf-authoring start fresh",
      uploadedAttachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "local",
      branch: "feature/existing",
      worktreePath: "/worktrees/existing",
      startFromOrigin: false,
      worktreeBranchName: "unused",
    });
    expect(input.selectedScientSkillNames).toEqual(["pdf-authoring"]);
  });
});
