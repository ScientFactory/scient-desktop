import { afterEach, describe, expect, it } from "vite-plus/test";
import "../../index.css";
import "./scient-reasoning-trace.css";

let host: HTMLDivElement | undefined;

afterEach(() => {
  host?.remove();
  host = undefined;
});

describe("expanded thought typography", () => {
  it.each(["400", "500"])("keeps emphasis at the surrounding weight %s", (weight) => {
    const thought = document.createElement("div");
    host = document.createElement("div");
    host.dataset.scientReasoningTrace = "true";
    thought.className = "chat-markdown";
    thought.style.fontWeight = weight;
    thought.innerHTML = "<h3>Writing a note</h3><p><strong>Checking the file</strong></p>";
    host.append(thought);
    document.body.append(host);

    for (const element of thought.querySelectorAll("h3, strong")) {
      expect(getComputedStyle(element).fontWeight).toBe(weight);
      expect(getComputedStyle(element).fontStyle).toBe("normal");
    }
  });

  it("draws an expanded thought in its collapsed row's colour, not an answer's", () => {
    host = document.createElement("div");
    host.dataset.scientReasoningTrace = "true";
    const thought = document.createElement("div");
    // As the timeline mounts it, with upstream's text-foreground.
    thought.className = "chat-markdown text-foreground";
    thought.innerHTML = "<p>Clarifying user requirements</p>";
    const label = document.createElement("span");
    label.className = "text-secondary-label";
    const answer = document.createElement("div");
    answer.className = "chat-markdown text-foreground";
    host.append(thought, label);
    document.body.append(host, answer);
    const colour = getComputedStyle(thought.querySelector("p")!).color;
    expect(colour).toBe(getComputedStyle(label).color);
    expect(colour).not.toBe(getComputedStyle(answer).color);
    answer.remove();
  });

  it("retains heading and bold styling in ordinary assistant replies", () => {
    const reply = document.createElement("div");
    host = reply;
    reply.className = "chat-markdown";
    reply.style.fontWeight = "400";
    reply.innerHTML = "<h3>Result</h3><p><strong>Summary</strong></p>";
    document.body.append(reply);

    for (const element of reply.querySelectorAll("h3, strong")) {
      expect(Number(getComputedStyle(element).fontWeight)).toBeGreaterThan(400);
    }
  });
});
