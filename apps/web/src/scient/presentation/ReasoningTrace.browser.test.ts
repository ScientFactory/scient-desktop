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
