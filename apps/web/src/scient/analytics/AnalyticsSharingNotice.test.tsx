// @vitest-environment happy-dom
import type { ScientAnalyticsStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("@tanstack/react-router", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
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

let root: Root;
let container: HTMLDivElement;
const storageKey = "scient:analytics-sharing-notice:v1:local";
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  localStorage.clear();
  mocks.environment = "local";
  mocks.connected = true;
  mocks.pathname = "/";
  mocks.readStatus.mockResolvedValue({ available: true, consent: "diagnostic" });
  mocks.add.mockReturnValue("notice");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(() => {
    // Match real router/connection subscriptions, including compiler-cached parents.
    for (const listener of mocks.listeners) listener();
    root.render(
      <StrictMode>
        <AnalyticsSharingNotice enabled />
      </StrictMode>,
    );
  });
}

describe("analytics sharing notice", () => {
  it("is disabled by default without reading status or storing a dismissal", async () => {
    await act(() => root.render(<AnalyticsSharingNotice />));
    expect(mocks.readStatus).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("closes an already visible notice when disabled without changing its dismissal record", async () => {
    await render();
    await act(() => root.render(<AnalyticsSharingNotice enabled={false} />));
    expect(mocks.close).toHaveBeenCalledWith("notice");
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("shows one persistent notice using the same information component as Settings", async () => {
    await render();
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
    await render();
    await act(() => mocks.add.mock.calls[0]![0].data.onClose());
    expect(localStorage.getItem(storageKey)).toBe("true");
    await act(() => root.render(null));
    await render();
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it("links to the exact privacy setting and dismisses without changing consent", async () => {
    await render();
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
    mocks.readStatus.mockResolvedValue(status);
    await render();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("waits for a connection and ignores failed status reads", async () => {
    mocks.connected = false;
    await render();
    expect(mocks.readStatus).not.toHaveBeenCalled();
    mocks.connected = true;
    mocks.readStatus.mockRejectedValue(new Error("offline"));
    await render();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("ignores a status response arriving after disconnect", async () => {
    let resolve!: (status: ScientAnalyticsStatus) => void;
    const pending = new Promise<ScientAnalyticsStatus>((done) => {
      resolve = done;
    });
    mocks.readStatus.mockReturnValue(pending);
    await render();
    mocks.connected = false;
    await render();
    await act(() => resolve({ available: true, consent: "diagnostic" }));
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("remembers leaving the screen so returning does not show the notice again", async () => {
    await render();
    mocks.pathname = "/settings/general";
    await render();
    expect(mocks.close).toHaveBeenCalledWith("notice");
    expect(localStorage.getItem(storageKey)).toBe("true");
    mocks.pathname = "/";
    await render();
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it("dismisses when switching away from the app and stays dismissed on return", async () => {
    await render();
    await act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(mocks.close).toHaveBeenCalledWith("notice");
    expect(localStorage.getItem(storageKey)).toBe("true");
    await act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(() => root.render(null));
    await render();
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it("dismisses when the document becomes hidden", async () => {
    await render();
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
    await render();
    const reads = mocks.readStatus.mock.calls.length;
    mocks.pathname = "/project/another";
    await render();
    expect(mocks.readStatus).toHaveBeenCalledTimes(reads);
    await act(() => mocks.add.mock.calls[0]![0].data.onClose());
    mocks.environment = "another";
    await render();
    expect(mocks.add).toHaveBeenCalledTimes(2);
  });
});
