// @vitest-environment happy-dom
import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MarkdownPersistenceTransport } from "./markdownPersistenceTransport";

const mocks = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("./markdownPersistenceTransport", () => ({
  createMarkdownPersistenceTransport: mocks.createTransport,
}));

import { useMarkdownPersistenceLease } from "./useMarkdownPersistenceLease";

describe("useMarkdownPersistenceLease", () => {
  const environmentId = EnvironmentId.make("hook-synthetic-environment");
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let latest: ReturnType<typeof useMarkdownPersistenceLease>;
  let transport: MarkdownPersistenceTransport;
  let pathIndex = 0;
  const cwd = "/synthetic-workspace";
  let initial: ProjectReadFileResult;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    pathIndex += 1;
    initial = {
      contents: "A",
      revision: "rA",
      byteLength: 1,
      truncated: false,
      relativePath: `hook-${pathIndex}.md`,
    };
    transport = {
      write: vi.fn(async (intent) => ({ revision: `r${intent.source}` })),
      read: vi.fn(async () => ({ source: "A", revision: "rA" })),
      classifyFailure: () => "terminal",
      subscribe: vi.fn(() => vi.fn()),
      project: vi.fn(),
    };
    mocks.createTransport.mockReset().mockReturnValue(transport);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function Surface(props: { snapshot?: ProjectReadFileResult | null; path?: string }) {
    const current = useMarkdownPersistenceLease({
      target: { environmentId, cwd, relativePath: props.path ?? initial.relativePath },
      authoritativeSnapshot: props.snapshot === undefined ? initial : props.snapshot,
    });
    useLayoutEffect(() => {
      latest = current;
    }, [current]);
    return <span>{current.snapshot?.draftSource ?? "loading"}</span>;
  }

  it("survives StrictMode effect replay and re-rendered cache snapshots with one coordinator", async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <Surface />
        </StrictMode>,
      ),
    );
    const lease = latest.lease!;
    await act(async () => {
      expect(lease.change("B", 0)).toBe(true);
    });
    await act(async () =>
      root.render(
        <StrictMode>
          <Surface snapshot={{ ...initial, contents: "stale", revision: "stale" }} />
        </StrictMode>,
      ),
    );
    expect(latest.lease).toBe(lease);
    expect(container.textContent).toBe("B");
    expect(mocks.createTransport).toHaveBeenCalledTimes(1);
    await act(async () => {
      await lease.flushNow();
    });
    expect(transport.write).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing draft when later cached data is unavailable or truncated", async () => {
    await act(async () => root.render(<Surface />));
    const lease = latest.lease!;
    await act(async () => {
      lease.change("B", 0);
    });
    await act(async () => root.render(<Surface snapshot={null} />));
    expect(latest.lease).toBe(lease);
    await act(async () => root.render(<Surface snapshot={{ ...initial, truncated: true }} />));
    expect(latest.lease).toBe(lease);
    expect(container.textContent).toBe("B");
  });

  it("revokes old callbacks on a path switch and never displays the old binding for the new path", async () => {
    await act(async () => root.render(<Surface />));
    const previous = latest.lease!;
    vi.mocked(transport.read).mockResolvedValue({ source: "other", revision: "rother" });
    await act(async () =>
      root.render(
        <Surface
          path="other-hook.md"
          snapshot={{
            ...initial,
            relativePath: "other-hook.md",
            contents: "other",
            revision: "rother",
          }}
        />,
      ),
    );
    expect(container.textContent).toBe("other");
    expect(previous.change("late", 0)).toBe(false);
    expect(latest.lease?.target.relativePath).toBe("other-hook.md");
  });

  it("exposes a failed ordered admission without enabling an editor and retries explicitly", async () => {
    const failure = new Error("Unavailable");
    vi.mocked(transport.read).mockRejectedValueOnce(failure);
    await act(async () => root.render(<Surface />));
    expect(latest.lease).toBeNull();
    expect(latest.admissionError).toBe(failure);
    expect(container.textContent).toBe("loading");
    await act(async () => latest.retryAdmission());
    expect(latest.admissionError).toBeNull();
    expect(latest.lease).not.toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("does not attach a late bootstrap result to a different path", async () => {
    let finishFirst!: (snapshot: { source: string; revision: string }) => void;
    const pending = new Promise<{ source: string; revision: string }>((resolve) => {
      finishFirst = resolve;
    });
    vi.mocked(transport.read)
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ source: "second", revision: "second" });
    await act(async () => root.render(<Surface />));
    expect(latest.lease).toBeNull();
    await act(async () => root.render(<Surface path="late-bootstrap-target.md" />));
    const second = latest.lease;
    expect(container.textContent).toBe("second");
    await act(async () => finishFirst({ source: "late first", revision: "late-first" }));
    expect(latest.lease).toBe(second);
    expect(container.textContent).toBe("second");
  });
});
