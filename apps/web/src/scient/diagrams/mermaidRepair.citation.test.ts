// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import {
  parseAssistantCitationHref,
  formatAssistantCitationHref,
} from "@t3tools/shared/assistantCitations";
import { resolveAssistantCitationRange } from "~/lib/assistantTextSelection";
import { createMermaidRepairCitation } from "./mermaidRepair";

const identity = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("assistant"),
};

function fixture(source: string, hidden = false) {
  const viewport = document.createElement("div");
  viewport.dataset.assistantCitationViewport = "";
  viewport.innerHTML = `<div data-assistant-citation-source="assistant" data-assistant-citation-environment="local" data-assistant-citation-thread="thread"><p>Earlier paragraph 👋</p><div data-scient-visual-card><span>Parse error</span><div><pre><code></code></pre></div></div></div>`;
  const code = viewport.querySelector("code")!;
  code.textContent = source;
  code.parentElement!.parentElement!.hidden = hidden;
  document.body.append(viewport);
  return {
    viewport,
    root: viewport.firstElementChild as HTMLElement,
    error: viewport.querySelector("span")!,
  };
}
afterEach(() => document.body.replaceChildren());

describe("Mermaid repair citation provenance", () => {
  it("can cite an empty diagram error without inventing a nonempty source quote", () => {
    const { error } = fixture("");
    const citation = createMermaidRepairCitation(identity, error, "", "Empty diagram");
    expect(citation?.text).toBe("Parse error");
    expect(citation?.comment).toContain("Empty diagram");
  });

  it.each(['flowchart LR\nA["test <value> & `code`"]', 'flowchart LR\nA["בדיקה 👋"]\n  A --> B'])(
    "uses the actual quote location and preserves source through serialization: %s",
    (source) => {
      const { root, error } = fixture(source);
      const citation = createMermaidRepairCitation(identity, error, source, "Expected ]\n```\n^")!;
      expect(citation.text).toBe(source);
      expect(citation.start).toBeGreaterThan(0);
      expect(parseAssistantCitationHref(formatAssistantCitationHref(citation))).toEqual(citation);
      expect(resolveAssistantCitationRange(root, citation)?.toString()).toBe(source);
      expect(citation.comment).toContain("Expected ]\n```\n^");
    },
  );

  it("never relabels a different response or thread as the source", () => {
    const { error } = fixture("flowchart LR\nA[");
    expect(
      createMermaidRepairCitation(
        { ...identity, messageId: MessageId.make("other") },
        error,
        "flowchart LR\nA[",
        "Parse error",
      ),
    ).toBeNull();
    expect(
      createMermaidRepairCitation(
        { ...identity, threadId: ThreadId.make("other") },
        error,
        "flowchart LR\nA[",
        "Parse error",
      ),
    ).toBeNull();
  });

  it("respects capsule limits without silently truncating the diagram or diagnostic", () => {
    for (const length of [
      ASSISTANT_CITATION_MAX_TEXT_LENGTH,
      ASSISTANT_CITATION_MAX_TEXT_LENGTH + 1,
    ]) {
      const source = "x".repeat(length);
      const { error } = fixture(source);
      const citation = createMermaidRepairCitation(identity, error, source, "Parse error");
      expect(citation?.text ?? null).toBe(
        length === ASSISTANT_CITATION_MAX_TEXT_LENGTH ? source : null,
      );
    }
    const { error } = fixture("flowchart LR\nA[");
    expect(
      createMermaidRepairCitation(identity, error, "flowchart LR\nA[", "x".repeat(8_000)),
    ).toBeNull();
  });
});
