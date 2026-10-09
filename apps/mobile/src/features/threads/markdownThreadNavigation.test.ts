import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { formatThreadLink, relabelThreadLinks } from "@t3tools/shared/threadLinks";
import { describe, expect, it, vi } from "vite-plus/test";
import { resolveMarkdownThreadNavigation } from "./markdownThreadNavigation";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const existing = (environmentId: EnvironmentId, threadId: string) => (ref: ScopedThreadRef) =>
  ref.environmentId === environmentId && ref.threadId === threadId;

function linkHref(id: string) {
  const markdown = relabelThreadLinks(formatThreadLink(id, "Written title"), (candidate) =>
    candidate === id ? "Current title" : undefined,
  );
  return markdown.slice(markdown.indexOf("](") + 2, -1);
}

describe("native Markdown thread navigation", () => {
  it("resolves a newly written unsafe ID through the canonical decoded fallback", () => {
    const threadId = ThreadId.make("mcp:(1)/2");
    const href = linkHref(threadId);
    expect(href).toBe("t3-thread://v1/mcp:%281%29%2F2");
    expect(resolveMarkdownThreadNavigation(href, local, existing(local, threadId))).toEqual({
      environmentId: local,
      threadId,
    });
  });

  it("keeps a literal percent identity when it collides with an available decoded ID", () => {
    const written = ThreadId.make("thread%2F1");
    const hasThread = vi.fn(
      (ref: ScopedThreadRef) =>
        ref.environmentId === local && [written, "thread/1"].includes(ref.threadId),
    );
    expect(resolveMarkdownThreadNavigation(linkHref(written), local, hasThread)).toEqual({
      environmentId: local,
      threadId: written,
    });
    expect(hasThread).toHaveBeenCalledTimes(1);
  });

  it("does not take a decoded target from another environment", () => {
    const written = ThreadId.make("thread%2F1");
    expect(
      resolveMarkdownThreadNavigation(linkHref(written), local, existing(remote, "thread/1")),
    ).toEqual({
      environmentId: local,
      threadId: written,
    });
  });

  it("preserves legacy qualified environment and already-decoded literal percent identity", () => {
    const hasThread = vi.fn(existing(remote, "thread/1"));
    expect(
      resolveMarkdownThreadNavigation("t3-thread://v1/remote/thread%252F1", local, hasThread),
    ).toEqual({
      environmentId: remote,
      threadId: "thread%2F1",
    });
    expect(hasThread).not.toHaveBeenCalled();
  });

  it("keeps a missing target's written identity without inventing a decoded route", () => {
    expect(
      resolveMarkdownThreadNavigation("t3-thread://v1/thread%2F1", local, () => false),
    ).toEqual({
      environmentId: local,
      threadId: "thread%2F1",
    });
  });

  it("declines non-thread and malformed qualified links", () => {
    expect(resolveMarkdownThreadNavigation("https://example.com", local, () => true)).toBeNull();
    expect(
      resolveMarkdownThreadNavigation("t3-thread://v1/remote/thread/extra", local, () => true),
    ).toBeNull();
  });
});
