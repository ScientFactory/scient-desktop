import { describe, expect, it } from "vite-plus/test";
import "../../index.css";
import "./scient-reasoning-trace.css";

async function _cleanupFixture0(_fixture: _Fixture) {
  _fixture.host?.remove();
  _fixture.host = undefined;
}

describe("expanded thought typography", () => {
  // regression: cac738b234 fix(timeline): refine trace symbols and thought typography
  // The rule inherits whatever weight surrounds it, so one weight covers the path.
  it("keeps emphasis at the surrounding weight", async () => {
    const weight = "500";
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const thought = document.createElement("div");
    _fixture.host = document.createElement("div");
    _fixture.host.dataset.scientReasoningTrace = "true";
    thought.className = "chat-markdown";
    thought.style.fontWeight = weight;
    thought.innerHTML = "<h3>Writing a note</h3><p><strong>Checking the file</strong></p>";
    _fixture.host.append(thought);
    document.body.append(_fixture.host);

    for (const element of thought.querySelectorAll("h3, strong")) {
      expect(getComputedStyle(element).fontWeight).toBe(weight);
      expect(getComputedStyle(element).fontStyle).toBe("normal");
    }
  });

  // regression: 010d58e874 fix(chat): thoughts read quietly when expanded (headings: f9ded2686c)
  it("draws an expanded thought in its collapsed row's colour, not an answer's", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    _fixture.host = document.createElement("div");
    _fixture.host.dataset.scientReasoningTrace = "true";
    const thought = document.createElement("div");
    // As the timeline mounts it, with upstream's text-foreground.
    thought.className = "chat-markdown text-foreground";
    thought.innerHTML = "<h3>Clarifying user requirements</h3><p>I think we need to ask.</p>";
    const label = document.createElement("span");
    label.className = "text-secondary-label";
    const answer = document.createElement("div");
    answer.className = "chat-markdown text-foreground";
    _fixture.host.append(thought, label);
    document.body.append(_fixture.host, answer);
    // Its headings too, which upstream colours on their own.
    for (const element of thought.querySelectorAll("h3, p")) {
      const colour = getComputedStyle(element).color;
      expect(colour).toBe(getComputedStyle(label).color);
      expect(colour).not.toBe(getComputedStyle(answer).color);
    }
    answer.remove();
  });

  // regression: cac738b234 fix(timeline): refine trace symbols and thought typography
  it("retains heading and bold styling in ordinary assistant replies", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const reply = document.createElement("div");
    _fixture.host = reply;
    reply.className = "chat-markdown";
    reply.style.fontWeight = "400";
    reply.innerHTML = "<h3>Result</h3><p><strong>Summary</strong></p>";
    document.body.append(reply);

    for (const element of reply.querySelectorAll("h3, strong")) {
      expect(Number(getComputedStyle(element).fontWeight)).toBeGreaterThan(400);
    }
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
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
