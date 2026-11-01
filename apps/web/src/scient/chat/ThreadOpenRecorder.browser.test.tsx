import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

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

async function renderRecorder(lastVisitedAt: string | null) {
  visit.mockClear();
  claim.mockClear();
  shell.current = {
    environmentId,
    id: threadId,
    lastVisitedAt,
    updatedAt: "2026-10-24T12:00:00.000Z",
  };
  const { ThreadOpenRecorder } = await import("./ThreadOpenRecorder");
  return render(<ThreadOpenRecorder threadRef={scopeThreadRef(environmentId, threadId)} />, {
    router: false,
  });
}

it("records an open at the current watermark, never at the thread's latest activity", async () => {
  await using _screen = await renderRecorder("2026-10-24T10:00:00.000Z");
  expect(claim).toHaveBeenCalledOnce();
  expect(visit).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, visitedAt: "2026-10-24T10:00:00.000Z", opened: true },
  });
});

it("keeps a never-read thread's open local", async () => {
  await using _screen = await renderRecorder(null);
  expect(claim).toHaveBeenCalledOnce();
  expect(visit).not.toHaveBeenCalled();
});
