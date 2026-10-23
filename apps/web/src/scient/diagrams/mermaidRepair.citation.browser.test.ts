import { describe, expect, it } from "vite-plus/test";
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

function fixture(_fixture: _Fixture, source: string, hidden = false) {
  const viewport = document.createElement("div");
  viewport.dataset.assistantCitationViewport = "";
  viewport.innerHTML = `<div data-assistant-citation-source="assistant" data-assistant-citation-environment="local" data-assistant-citation-thread="thread"><p>Earlier paragraph 👋</p><div data-scient-visual-card><span>Parse error</span><div><pre><code></code></pre></div></div></div>`;
  const code = viewport.querySelector("code")!;
  code.textContent = source;
  code.parentElement!.parentElement!.hidden = hidden;
  document.body.append(_ownDOM(_fixture, viewport));
  return {
    viewport,
    root: viewport.firstElementChild as HTMLElement,
    error: viewport.querySelector("span")!,
  };
}
async function _cleanupFixture0(_fixture: _Fixture) {
  await _clearOwnedDOM(_fixture);
}

describe("Mermaid repair citation provenance", () => {
  it("can cite an empty diagram error without inventing a nonempty source quote", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { error } = fixture(_fixture, "");
    const citation = createMermaidRepairCitation(identity, error, "", "Empty diagram");
    expect(citation?.text).toBe("Parse error");
    expect(citation?.comment).toContain("Empty diagram");
  });

  it.each(['flowchart LR\nA["test <value> & `code`"]', 'flowchart LR\nA["בדיקה 👋"]\n  A --> B'])(
    "uses the actual quote location and preserves source through serialization: %s",
    async (source) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const { root, error } = fixture(_fixture, source);
      const citation = createMermaidRepairCitation(identity, error, source, "Expected ]\n```\n^")!;
      expect(citation.text).toBe(source);
      expect(citation.start).toBeGreaterThan(0);
      expect(parseAssistantCitationHref(formatAssistantCitationHref(citation))).toEqual(citation);
      expect(resolveAssistantCitationRange(root, citation)?.toString()).toBe(source);
      expect(citation.comment).toContain("Expected ]\n```\n^");
    },
  );

  it("never relabels a different response or thread as the source", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { error } = fixture(_fixture, "flowchart LR\nA[");
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

  it("respects capsule limits without silently truncating the diagram or diagnostic", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    for (const length of [
      ASSISTANT_CITATION_MAX_TEXT_LENGTH,
      ASSISTANT_CITATION_MAX_TEXT_LENGTH + 1,
    ]) {
      const source = "x".repeat(length);
      const { error } = fixture(_fixture, source);
      const citation = createMermaidRepairCitation(identity, error, source, "Parse error");
      expect(citation?.text ?? null).toBe(
        length === ASSISTANT_CITATION_MAX_TEXT_LENGTH ? source : null,
      );
    }
    const { error } = fixture(_fixture, "flowchart LR\nA[");
    expect(
      createMermaidRepairCitation(identity, error, "flowchart LR\nA[", "x".repeat(8_000)),
    ).toBeNull();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
