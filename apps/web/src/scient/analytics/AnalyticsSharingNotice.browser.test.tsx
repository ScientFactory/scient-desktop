import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import type { ScientAnalyticsStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { StrictMode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environment: "local",
  connected: true,
  pathname: "/",
  prepared: {},
  readStatus: vi.fn(),
  add: vi.fn(),
  close: vi.fn(),
  navigate: vi.fn(),
  listeners: new Set<() => void>(),
  subscribe: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => {
      mocks.listeners.delete(listener);
    };
  },
}));
vi.mock("../../state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePrimaryEnvironmentId: () => useSyncExternalStore(mocks.subscribe, () => mocks.environment),
  };
});
vi.mock("../../state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePreparedConnection: () => {
      const connected = useSyncExternalStore(mocks.subscribe, () => mocks.connected);
      return connected ? Option.some(mocks.prepared) : Option.none();
    },
  };
});
vi.mock("@tanstack/react-router", async (_actualRouter) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await _actualRouter<typeof import("@tanstack/react-router")>()),
    useNavigate: () => mocks.navigate,
    useLocation: ({ select }: { select: (location: { pathname: string }) => string }) => {
      const pathname = useSyncExternalStore(mocks.subscribe, () => mocks.pathname);
      return select({ pathname });
    },
  };
});
vi.mock("./client", () => ({ readScientAnalyticsStatus: mocks.readStatus }));
vi.mock("../../components/ui/toast", () => ({
  stackedThreadToast: (options: unknown) => options,
  toastManager: { add: mocks.add, close: mocks.close },
}));

import { AnalyticsSharingNotice } from "./AnalyticsSharingNotice";
import { AnalyticsSharingInfo } from "./AnalyticsSharingInfo";

const storageKey = "scient:analytics-sharing-notice:v1:local";
async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.environment = "local";
  mocks.connected = true;
  mocks.pathname = "/";
  mocks.readStatus.mockResolvedValue({ available: true, consent: "diagnostic" });
  mocks.add.mockReturnValue("notice");
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
  vi.unstubAllGlobals();
}
async function render(_fixture: _Fixture) {
  await act(async () => {
    // Match real router/connection subscriptions, including compiler-cached parents.
    for (const listener of mocks.listeners) listener();
    await _fixture.root0.rerender(
      <StrictMode>
        <AnalyticsSharingNotice enabled />
      </StrictMode>,
    );
  });
}

describe("analytics sharing notice", () => {
  it("is disabled by default without reading status or storing a dismissal", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(async () => await _fixture.root0.rerender(<AnalyticsSharingNotice />));
    expect(mocks.readStatus).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("closes an already visible notice when disabled without changing its dismissal record", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(
      async () => await _fixture.root0.rerender(<AnalyticsSharingNotice enabled={false} />),
    );
    expect(mocks.close).toHaveBeenCalledWith("notice");
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("shows one persistent notice using the same information component as Settings", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    expect(mocks.add).toHaveBeenCalledTimes(1);
    const notice = mocks.add.mock.calls[0]![0];
    expect(notice.title).toBe("Analytics sharing is on");
    expect(notice.timeout).toBe(0);
    expect(notice.description.type).toBe("p");
    expect(notice.data.fullWidthDescription).toBe(true);
    expect(notice.data.actionLeadingContent.type).toBe(AnalyticsSharingInfo);
    expect(notice.actionVariant).toBe("link");
    expect(notice.actionProps.children.props.children[0]).toBe("Review in settings ");
    expect(notice.actionProps.children.props.children[1].props["aria-hidden"]).toBe("true");
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("persists explicit dismissal and does not show again after remount", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(() => mocks.add.mock.calls[0]![0].data.onClose());
    expect(localStorage.getItem(storageKey)).toBe("true");
    await act(async () => await _fixture.root0.rerender(null));
    await render(_fixture);
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it("links to the exact privacy setting and dismisses without changing consent", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(() => mocks.add.mock.calls[0]![0].actionProps.onClick());
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/settings/general",
      hash: "scient-analytics",
    });
    expect(localStorage.getItem(storageKey)).toBe("true");
    expect(mocks.close).toHaveBeenCalledWith("notice");
  });

  it.each([
    { available: true, consent: "off" },
    { available: false, consent: "off" },
  ] as const)("does not claim sharing is on for %j", async (status) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.readStatus.mockResolvedValue(status);
    await render(_fixture);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("waits for a connection and ignores failed status reads", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.connected = false;
    await render(_fixture);
    expect(mocks.readStatus).not.toHaveBeenCalled();
    mocks.connected = true;
    mocks.readStatus.mockRejectedValue(new Error("offline"));
    await render(_fixture);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("ignores a status response arriving after disconnect", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let resolve!: (status: ScientAnalyticsStatus) => void;
    const pending = new Promise<ScientAnalyticsStatus>((done) => {
      resolve = done;
    });
    mocks.readStatus.mockReturnValue(pending);
    await render(_fixture);
    mocks.connected = false;
    await render(_fixture);
    await act(() => resolve({ available: true, consent: "diagnostic" }));
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("remembers leaving the screen so returning does not show the notice again", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    mocks.pathname = "/settings/general";
    await render(_fixture);
    expect(mocks.close).toHaveBeenCalledWith("notice");
    expect(localStorage.getItem(storageKey)).toBe("true");
    mocks.pathname = "/";
    await render(_fixture);
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it("dismisses when switching away from the app and stays dismissed on return", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(mocks.close).toHaveBeenCalledWith("notice");
    expect(localStorage.getItem(storageKey)).toBe("true");
    await act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => await _fixture.root0.rerender(null));
    await render(_fixture);
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it("dismisses when the document becomes hidden", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      await act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(localStorage.getItem(storageKey)).toBe("true");
      expect(mocks.close).toHaveBeenCalledWith("notice");
    } finally {
      visibility.mockRestore();
    }
  });

  it("scopes dismissal to the environment and does not re-read on ordinary chat navigation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    const reads = mocks.readStatus.mock.calls.length;
    mocks.pathname = "/project/another";
    await render(_fixture);
    expect(mocks.readStatus).toHaveBeenCalledTimes(reads);
    await act(() => mocks.add.mock.calls[0]![0].data.onClose());
    mocks.environment = "another";
    await render(_fixture);
    expect(mocks.add).toHaveBeenCalledTimes(2);
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
