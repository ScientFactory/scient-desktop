import { EnvironmentId, ThreadId, type FileCitation } from "@t3tools/contracts";
import { serializeComposerCitation } from "@t3tools/shared/composerCitations";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { expect, it } from "vite-plus/test";

import { queuePreviewText } from "./queuePreviewText";

// regression: queued rows used the assistant-citation decoder and showed encoded Scient quotes.
it("shows a quoted file selection as its text and comment", () => {
  const quote: FileCitation = {
    kind: "file",
    version: 1,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    cwd: "/project",
    path: "notes.md",
    revision: `sha256:${"a".repeat(64)}`,
    origin: "draft",
    sourceStart: 0,
    sourceEnd: 40,
    startLine: 1,
    endLine: 2,
    from: 0,
    to: 9,
    text: "the claim",
    prefix: "",
    suffix: "",
    comment: "Check it",
  };
  expect(queuePreviewText(`Before ${serializeComposerCitation(quote)} after`)).toBe(
    "Before the claim\nComment: Check it after",
  );
});

it("shows an @-file mention by its file name", () => {
  expect(queuePreviewText(`Review ${serializeComposerFileLink("src/foo.ts")} now`)).toBe(
    "Review foo.ts now",
  );
});
