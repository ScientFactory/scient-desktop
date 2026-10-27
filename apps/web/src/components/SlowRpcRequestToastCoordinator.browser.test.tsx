import { render as _fixtureRender, type Screen, act } from "../../test/render";
import { type ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  update: vi.fn(),
  close: vi.fn(),
  timestampFormat: "24-hour" as "12-hour" | "24-hour" | "locale",
  startedAt: "",
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { timestampFormat: string }) => unknown) =>
    selector({ timestampFormat: mocks.timestampFormat }),
}));
vi.mock("../rpc/requestLatencyState", () => ({
  subscribeSlowRpcAckRequests: (listener: (requests: ReadonlyArray<unknown>) => void) => {
    listener([
      {
        requestId: "request:synthetic",
        tag: "Synthetic request",
        startedAt: mocks.startedAt,
        startedAtMs: 0,
        thresholdMs: 15000,
      },
    ]);
    return () => {};
  },
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: mocks.add, update: mocks.update, close: mocks.close },
}));

import { startSlowRpcRequestToasts } from "./SlowRpcRequestToastCoordinator";

async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
  mocks.timestampFormat = "24-hour";
  mocks.startedAt = new Date(2026, 8, 15, 17, 4, 3).toISOString();
  mocks.add.mockReturnValue("toast:synthetic");
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
}
async function renderDetails(_fixture: _Fixture) {
  _fixture.cleanup.defer(startSlowRpcRequestToasts());
  const toast = mocks.add.mock.calls[0]?.[0] as { data: { expandableContent: ReactNode } };
  expect(toast).toBeDefined();
  await act(async () => await _fixture.root0.rerender(toast.data.expandableContent));
}

describe("Slow RPC receipt times", () => {
  it.each(["12-hour", "24-hour"] as const)(
    "uses the selected %s clock",
    async (timestampFormat) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      mocks.timestampFormat = timestampFormat;
      await renderDetails(_fixture);
      const expected = new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: timestampFormat === "12-hour",
      }).format(new Date(mocks.startedAt));
      expect(_fixture.container.textContent).toContain(`Started ${expected}`);
      expect(_fixture.container.textContent).toContain("Synthetic request");
    },
  );
  it("preserves the request while omitting a malformed clock value", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.startedAt = "not-a-date";
    await renderDetails(_fixture);
    expect(_fixture.container.textContent).toContain("Synthetic request");
    expect(_fixture.container.textContent).not.toContain("Invalid Date");
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
