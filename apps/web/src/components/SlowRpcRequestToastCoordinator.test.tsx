// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  useSlowRpcAckRequests: () => [
    {
      requestId: "request:synthetic",
      tag: "Synthetic request",
      startedAt: mocks.startedAt,
      startedAtMs: 0,
      thresholdMs: 15000,
    },
  ],
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: mocks.add, update: mocks.update, close: mocks.close },
}));

import { SlowRpcRequestToastCoordinator } from "./SlowRpcRequestToastCoordinator";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.timestampFormat = "24-hour";
  mocks.startedAt = new Date(2026, 8, 15, 17, 4, 3).toISOString();
  mocks.add.mockReturnValue("toast:synthetic");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function renderDetails() {
  await act(async () => root.render(<SlowRpcRequestToastCoordinator />));
  const toast = mocks.add.mock.calls[0]?.[0] as { data: { expandableContent: ReactNode } };
  expect(toast).toBeDefined();
  await act(async () => root.render(toast.data.expandableContent));
}

describe("Slow RPC receipt times", () => {
  it.each(["12-hour", "24-hour"] as const)(
    "uses the selected %s clock",
    async (timestampFormat) => {
      mocks.timestampFormat = timestampFormat;
      await renderDetails();
      const expected = new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: timestampFormat === "12-hour",
      }).format(new Date(mocks.startedAt));
      expect(container.textContent).toContain(`Started ${expected}`);
      expect(container.textContent).toContain("Synthetic request");
    },
  );
  it("preserves the request while omitting a malformed clock value", async () => {
    mocks.startedAt = "not-a-date";
    await renderDetails();
    expect(container.textContent).toContain("Synthetic request");
    expect(container.textContent).not.toContain("Invalid Date");
  });
});
