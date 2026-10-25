import { describe, expect, it } from "vite-plus/test";
import {
  formatThreadLink,
  formatEnvironmentQualifiedThreadLink,
  parseEnvironmentQualifiedThreadLinkHref,
  parseThreadLinkHref,
  percentDecodedThreadLinkId,
  relabelThreadLinks,
} from "./threadLinks.ts";

describe("thread links", () => {
  it("reads stored qualified links without resolving them in the message's environment", () => {
    const href = "t3-thread://v1/studio%20mac/mcp%3A%281%29%2F2";
    expect(parseEnvironmentQualifiedThreadLinkHref(href)).toEqual({
      environmentId: "studio mac",
      threadId: "mcp:(1)/2",
    });
    expect(parseThreadLinkHref(href)).toBeNull();
    expect(relabelThreadLinks(`[Recorded title](${href})`, () => "Local duplicate")).toBe(
      `[Recorded title](${href})`,
    );
    const copied = formatEnvironmentQualifiedThreadLink(
      "studio mac",
      "mcp:(1)/2",
      "Fix [the] build\nnow",
    );
    expect(copied).toBe("[Fix the build now](t3-thread://v1/studio%20mac/mcp%3A%281%29%2F2)");
    expect(parseEnvironmentQualifiedThreadLinkHref(/\]\((.+)\)$/.exec(copied)![1]!)).toEqual({
      environmentId: "studio mac",
      threadId: "mcp:(1)/2",
    });
  });

  it("rejects malformed historical links instead of redirecting them locally", () => {
    for (const href of [
      "https://t3.codes",
      "t3-thread://v1/only-one",
      "t3-thread://v1/env/%E0%A4%A",
      "t3-thread://v1/%20/thread",
      "t3-thread://v1/env/thread/extra",
    ]) {
      expect(parseEnvironmentQualifiedThreadLinkHref(href)).toBeNull();
      if (
        href.startsWith("t3-thread://v1/") &&
        href.slice("t3-thread://v1/".length).includes("/")
      ) {
        expect(parseThreadLinkHref(href)).toBeNull();
      }
    }
  });

  it("writes slash and parenthesis ids safely and resolves them only after literal lookup", () => {
    const markdown = formatThreadLink("mcp:(1)/2", "Fix [the] build\nnow");
    expect(markdown).toBe("[Fix the build now](t3-thread://v1/mcp:%281%29%2F2)");
    const href = /\]\((.+)\)$/.exec(markdown)![1]!;
    const written = parseThreadLinkHref(href)!;
    expect(written).toBe("mcp:%281%29%2F2");
    expect(parseEnvironmentQualifiedThreadLinkHref(href)).toBeNull();
    expect(percentDecodedThreadLinkId(written)).toBe("mcp:(1)/2");
    const titles = new Map([["mcp:(1)/2", "Current title"]]);
    expect(relabelThreadLinks(markdown, (id) => titles.get(id))).toBe(
      "[Current title](t3-thread://v1/mcp:%281%29%2F2)",
    );
    titles.set("mcp:%281%29%2F2", "Literal title");
    expect(relabelThreadLinks(markdown, (id) => titles.get(id))).toBe(
      "[Literal title](t3-thread://v1/mcp:%281%29%2F2)",
    );
  });
});
