import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  formatThreadLink,
  parseThreadLinkHref,
  percentDecodedThreadLinkId,
  relabelThreadLinks,
} from "./threadLinks.ts";

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

  it("writes slash and parenthesis ids safely and resolves them only after literal lookup", () => {
    const threadId = ThreadId.make("mcp:(1)/2");
    const markdown = formatThreadLink({ environmentId: null, threadId }, "Fix [the] build\nnow");
    expect(markdown).toBe("[Fix the build now](t3-thread://v1/mcp:%281%29%2F2)");
    const written = parseThreadLinkHref(/\]\((.+)\)$/.exec(markdown)![1]!)!;
    expect(written).toEqual({ environmentId: null, threadId: "mcp:%281%29%2F2" });
    expect(percentDecodedThreadLinkId(written.threadId)).toBe("mcp:(1)/2");
    const titles = new Map([["mcp:(1)/2", "Current title"]]);
    expect(relabelThreadLinks(markdown, local, (ref) => titles.get(ref.threadId))).toBe(
      "[Current title](t3-thread://v1/mcp:%281%29%2F2)",
    );
    titles.set("mcp:%281%29%2F2", "Literal title");
    expect(relabelThreadLinks(markdown, local, (ref) => titles.get(ref.threadId))).toBe(
      "[Literal title](t3-thread://v1/mcp:%281%29%2F2)",
    );
  });
});
