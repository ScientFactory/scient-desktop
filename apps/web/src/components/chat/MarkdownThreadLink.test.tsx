import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { describe, expect, it, vi } from "vite-plus/test";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

const { reads, shells } = vi.hoisted(() => ({
  reads: vi.fn(),
  shells: new Map<string, { environmentId: string; id: string; title: string }>(),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: ScopedThreadRef | null) => {
    reads(ref);
    return ref === null ? null : (shells.get(`${ref.environmentId}/${ref.threadId}`) ?? null);
  },
  useThreadRefs: () => [],
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
const otherEnvironmentId = EnvironmentId.make("lab");
const threadId = ThreadId.make("thread-1");

function setup(shell: { environmentId: EnvironmentId; title: string }) {
  reads.mockClear();
  shells.clear();
  shells.set(`${shell.environmentId}/${threadId}`, { ...shell, id: threadId });
}

describe("MarkdownThreadLink identity", () => {
  it("resolves an ID-only link inside the message environment", () => {
    setup({ environmentId, title: "Current title" });
    const html = renderToStaticMarkup(
      <MarkdownThreadLink
        environmentId={environmentId}
        link={parseThreadLinkHref("t3-thread://v1/thread-1")!}
        label="Written title"
      />,
    );
    expect(reads).toHaveBeenCalledWith(expect.objectContaining({ environmentId, threadId }));
    expect(html).toContain('href="/remote/thread-1"');
    expect(html).toContain('data-markdown-copy="[Current title](t3-thread://v2/remote/thread-1)"');
  });

  it("retains an old cross-environment link's environment instead of converting it to local identity", () => {
    setup({ environmentId: otherEnvironmentId, title: "Saved title" });
    const html = renderToStaticMarkup(
      <MarkdownThreadLink
        environmentId={environmentId}
        link={parseThreadLinkHref("t3-thread://v1/lab/thread-1")!}
        label="Saved title"
      />,
    );
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: otherEnvironmentId, threadId }),
    );
    expect(html).toContain('href="/lab/thread-1"');
    expect(html).toContain('data-markdown-copy="[Saved title](t3-thread://v2/lab/thread-1)"');
  });
});
