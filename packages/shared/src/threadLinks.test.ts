import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  formatThreadLink,
  formatEnvironmentQualifiedThreadLink,
  parseEnvironmentQualifiedThreadLinkHref,
  parseThreadLinkHref,
  percentDecodedThreadLinkId,
  relabelThreadLinks,
  resolveThreadLinkRef,
} from "./threadLinks.ts";
const ref = (environmentId: string, threadId = "chat-1") => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});

describe("thread link destinations", () => {
  it("prefers the local literal id, then the local decoded id, over remote matches", () => {
    const source = ref("local", "provider%3A1");
    const decoded = ref("local", "provider:1");
    const remote = ref("remote", "provider%3A1");
    expect(resolveThreadLinkRef(source, [remote, decoded, source])).toEqual(source);
    expect(resolveThreadLinkRef(source, [remote, decoded])).toEqual(decoded);
  });

  it("opens the unique matching chat in another environment", () => {
    const destination = ref("remote");
    expect(resolveThreadLinkRef(ref("local"), [ref("local", "other-chat"), destination])).toEqual(
      destination,
    );
  });

  it("leaves ambiguous or missing destinations unresolved", () => {
    const source = ref("local", "provider%3A1");
    const literal = ref("remote", "provider%3A1");
    const decoded = ref("remote", "provider:1");
    expect(
      resolveThreadLinkRef(source, [literal, ref("other-remote", literal.threadId), decoded]),
    ).toBeNull();
    expect(
      resolveThreadLinkRef(source, [decoded, ref("other-remote", decoded.threadId)]),
    ).toBeNull();
    expect(resolveThreadLinkRef(source, [ref("remote", "other-chat")])).toBeNull();
  });
});

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

  it("takes the thread id verbatim, percent escapes included", () => {
    expect(parseThreadLinkHref("t3-thread://v1/mcp:1234")).toBe("mcp:1234");
    expect(parseThreadLinkHref("t3-thread://v1/thread:delegated-task:mcp%3A1")).toBe(
      "thread:delegated-task:mcp%3A1",
    );
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

  it("rejects other links and an empty id", () => {
    expect(parseThreadLinkHref("https://t3.codes")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/ ")).toBeNull();
  });

  it("resolves a percent-encoded id when the id as written names no thread", () => {
    const titles = new Map([
      ["thread:project:1", "Decoded"],
      ["provider%3A1", "Literal escape"],
    ]);
    expect(
      relabelThreadLinks(
        "[a](t3-thread://v1/thread%3Aproject%3A1) [b](t3-thread://v1/provider%3A1)",
        (threadId) => titles.get(threadId),
      ),
    ).toBe(
      "[Decoded](t3-thread://v1/thread:project:1) [Literal escape](t3-thread://v1/provider%3A1)",
    );
    const untitled = new Map([
      ["a%3A1", ""],
      ["a:1", "Other"],
    ]);
    expect(
      relabelThreadLinks("[Kept](t3-thread://v1/a%3A1)", (threadId) => untitled.get(threadId)),
    ).toBe("[Kept](t3-thread://v1/a%3A1)");
  });

  it("leaves links inside code spans and fences as written", () => {
    const markdown = [
      "Live [old](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
      "```md",
      "[old](t3-thread://v1/t1)",
      "```",
      "After [old](t3-thread://v1/t1)",
    ].join("\n");
    expect(relabelThreadLinks(markdown, () => "New")).toBe(
      [
        "Live [New](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
        "```md",
        "[old](t3-thread://v1/t1)",
        "```",
        "After [New](t3-thread://v1/t1)",
      ].join("\n"),
    );
  });

  it("formats a label that would otherwise break the Markdown link", () => {
    expect(formatThreadLink("t1", "Fix [ci] \\ build")).toBe("[Fix ci build](t3-thread://v1/t1)");
    expect(formatThreadLink("t1", " ] ")).toBe("[t1](t3-thread://v1/t1)");
  });
});
