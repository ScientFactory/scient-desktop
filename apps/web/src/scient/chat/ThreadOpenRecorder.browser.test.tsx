import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const shell = vi.hoisted(() => ({
  current: undefined as
    | {
        environmentId: string;
        id: string;
        lastVisitedAt: string | null | undefined;
        updatedAt: string;
      }
    | undefined,
}));
const visit = vi.hoisted(() => vi.fn(async () => ({ _tag: "Success" })));
const claim = vi.hoisted(() => vi.fn(() => true));

vi.mock("~/state/entities", () => ({ useThreadShell: () => shell.current }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => visit }));
vi.mock("~/state/threads", () => ({ threadEnvironment: { visit: {} } }));
vi.mock("@t3tools/client-runtime/state/thread-search", () => ({ claimThreadOpen: claim }));

const environmentId = EnvironmentId.make("environment-open");
const threadId = ThreadId.make("thread-open");

async function mount() {
  const { ThreadOpenRecorder } = await import("./ThreadOpenRecorder");
  const container = document.createElement("div");
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () =>
    root.render(<ThreadOpenRecorder threadRef={scopeThreadRef(environmentId, threadId)} />),
  );
  return { [Symbol.dispose]: () => act(() => root.unmount()) };
}

afterEach(() => {
  visit.mockClear();
  claim.mockClear();
  vi.unstubAllGlobals();
});

it("records an open at the current watermark, never at the thread's latest activity", async () => {
  shell.current = {
    environmentId,
    id: threadId,
    lastVisitedAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T12:00:00.000Z",
  };
  using _mounted = await mount();
  expect(claim).toHaveBeenCalledOnce();
  expect(visit).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, visitedAt: "2026-10-24T10:00:00.000Z", opened: true },
  });
});

it("keeps a never-read thread's open local", async () => {
  shell.current = {
    environmentId,
    id: threadId,
    lastVisitedAt: null,
    updatedAt: "2026-10-24T12:00:00.000Z",
  };
  using _mounted = await mount();
  expect(claim).toHaveBeenCalledOnce();
  expect(visit).not.toHaveBeenCalled();
});
