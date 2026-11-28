import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  formatThreadLink,
  parseThreadLinkHref,
  percentDecodedThreadLinkId,
  threadLinkRefs,
} from "./threadLinks.ts";
import { relabelThreadLinks } from "./threadLinksCopy.ts";

const local = EnvironmentId.make("local");

describe("thread links", () => {
  it("opens stored environment-qualified v1 links in their recorded environment", () => {
    const href = "t3-thread://v1/studio%20mac/mcp%3A%281%29%2F2";
    expect(parseThreadLinkHref(href)).toEqual({
      environmentId: "studio mac",
      threadId: "mcp:(1)/2",
    });
    expect(relabelThreadLinks(`[Recorded title](${href})`, local, () => undefined)).toBe(
      "Recorded title",
    );
  });

  it("rejects malformed historical links instead of redirecting them locally", () => {
    for (const href of [
      "t3-thread://v1/env/%E0%A4%A",
      "t3-thread://v1/%20/thread",
      "t3-thread://v1/env/thread/extra",
    ]) {
      expect(parseThreadLinkHref(href)).toBeNull();
    }
  });

  it("writes slash ids escaped and resolves them only after literal lookup", () => {
    const threadId = ThreadId.make("mcp:(1)/2");
    const markdown = formatThreadLink({ environmentId: null, threadId }, "Fix [the] build\nnow");
    expect(markdown).toBe("[Fix the build now](<t3-thread://v1/mcp%3A(1)%2F2>)");
    const written = parseThreadLinkHref(/\]\(<(.+)>\)$/.exec(markdown)![1]!)!;
    expect(written).toEqual({ environmentId: null, threadId: "mcp%3A(1)%2F2" });
    expect(percentDecodedThreadLinkId(written.threadId)).toBe("mcp:(1)/2");
    const titles = new Map([["mcp:(1)/2", "Current title"]]);
    expect(relabelThreadLinks(markdown, local, (ref) => titles.get(ref.threadId))).toBe(
      "[Current title](<t3-thread://v1/mcp%3A(1)%2F2>)",
    );
    titles.set("mcp%3A(1)%2F2", "Literal title");
    expect(relabelThreadLinks(markdown, local, (ref) => titles.get(ref.threadId))).toBe(
      "[Literal title](<t3-thread://v1/mcp%3A(1)%2F2>)",
    );
  });

  it("still opens links saved with Scient's earlier %28/%29 escapes", () => {
    const titles = new Map([
      ["mcp:(1)/2", "Current title"],
      ["mcp:launch:qa(1)", "Launch"],
    ]);
    const title = (ref: { readonly threadId: string }) => titles.get(ref.threadId);
    const v1 = "[Saved](t3-thread://v1/mcp:%281%29%2F2)";
    expect(threadLinkRefs(v1, local)).toContainEqual({
      environmentId: local,
      threadId: "mcp:(1)/2",
    });
    expect(relabelThreadLinks(v1, local, title)).toBe(
      "[Current title](<t3-thread://v1/mcp%3A(1)%2F2>)",
    );
    const there = EnvironmentId.make("there");
    const v2 = "[Saved](t3-thread://v2/there/mcp:launch:qa%281%29)";
    expect(threadLinkRefs(v2, local)).toContainEqual({
      environmentId: there,
      threadId: "mcp:launch:qa(1)",
    });
    expect(relabelThreadLinks(v2, local, title)).toBe(
      "[Launch](<t3-thread://v2/there/mcp:launch:qa(1)>)",
    );
  });
});
