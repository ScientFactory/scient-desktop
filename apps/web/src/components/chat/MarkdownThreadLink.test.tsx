import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

const { reads } = vi.hoisted(() => ({ reads: vi.fn() }));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: unknown) => {
    reads(ref);
    return null;
  },
  useProject: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    params,
    ...props
  }: ComponentProps<"a"> & { params: { environmentId: string; threadId: string } }) => (
    <a {...props} href={`/${params.environmentId}/${params.threadId}`} />
  ),
}));

const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread-1");

describe("MarkdownThreadLink identity", () => {
  it("copies new links with an ID-only href and renders inside the message environment", () => {
    const html = renderToStaticMarkup(
      <MarkdownThreadLink
        environmentId={environmentId}
        threadId={threadId}
        label="Written title"
      />,
    );
    expect(html).toContain('href="/remote/thread-1"');
    expect(html).toContain('data-markdown-copy="[Written title](t3-thread://v1/thread-1)"');
  });

  it("retains an old cross-environment link when copying instead of converting it to local identity", () => {
    const html = renderToStaticMarkup(
      <MarkdownThreadLink
        environmentId={environmentId}
        threadId={threadId}
        label="Saved title"
        environmentQualified
      />,
    );
    expect(html).toContain('href="/remote/thread-1"');
    expect(html).toContain('data-markdown-copy="[Saved title](t3-thread://v1/remote/thread-1)"');
    expect(reads).toHaveBeenCalledWith(expect.objectContaining({ environmentId, threadId }));
  });
  it("does not decode a missing qualified literal-percent identity a second time", () => {
    reads.mockClear();
    const literalId = ThreadId.make("thread%2F1");
    const html = renderToStaticMarkup(
      <MarkdownThreadLink
        environmentId={environmentId}
        threadId={literalId}
        label="Saved title"
        environmentQualified
      />,
    );
    expect(html).toContain('href="/remote/thread%2F1"');
    expect(reads).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ environmentId, threadId: literalId }),
    );
    expect(reads).toHaveBeenNthCalledWith(2, null);
  });
});
