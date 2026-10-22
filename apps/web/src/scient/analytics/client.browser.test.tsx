import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";

const transport = vi.hoisted(() => ({
  status: vi.fn(async () => ({
    available: true,
    consent: "product",
    collectionContext: "context",
  })),
  record: vi.fn(async (_input: unknown) => undefined),
  connection: {},
  requestedEnvironment: null as unknown,
}));
vi.mock("../../lib/runtime", () => ({
  runtime: { runPromise: (operation: Promise<unknown>) => operation },
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("primary"),
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: (environment: unknown) => {
    transport.requestedEnvironment = environment;
    // The Option wrapper may change; the underlying connection is the identity.
    return Option.some(transport.connection);
  },
  readPreparedConnection: () => transport.connection,
}));
vi.mock("@t3tools/client-runtime/state/scient-analytics", () => ({
  getEnvironmentScientAnalyticsStatus: () => transport.status(),
  recordEnvironmentScientAnalyticsEvent: (input: unknown) => transport.record(input),
  deleteEnvironmentScientAnalyticsData: vi.fn(),
  updateEnvironmentScientAnalyticsPreference: vi.fn(),
}));
import { useScientAnalyticsView } from "./client";

function View({ visible, environment }: { visible: boolean; environment: string }) {
  useScientAnalyticsView(
    visible ? { name: "feature.viewed", properties: { feature: "latex-visual" } } : null,
    EnvironmentId.make(environment),
  );
  return null;
}

describe("analytics view hook lifecycle", () => {
  let dispose = () => {};
  afterEach(async () => {
    await act(async () => dispose());
    vi.restoreAllMocks();
  });

  it("does not recount rerenders or hidden retained editors and routes to the explicit environment", async () => {
    transport.connection = {};
    transport.record.mockClear();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    dispose = () => {
      root.unmount();
      container.remove();
    };
    const render = (visible: boolean) =>
      act(async () => {
        root.render(
          <StrictMode>
            <View visible={visible} environment="remote" />
          </StrictMode>,
        );
      });
    await render(false);
    expect(transport.record).not.toHaveBeenCalled();
    await render(true);
    for (let i = 0; i < 100; i++) await render(true);
    expect(transport.record).toHaveBeenCalledOnce();
    expect(transport.requestedEnvironment).toBe("remote");
    expect(transport.record).toHaveBeenCalledWith({
      prepared: transport.connection,
      event: {
        name: "feature.viewed",
        properties: { feature: "latex-visual" },
        collectionContext: "context",
      },
    });
    await render(false);
    await render(true);
    expect(transport.record).toHaveBeenCalledTimes(2);
    transport.connection = {};
    await render(true);
    expect(transport.record).toHaveBeenCalledTimes(3);
  });

  it("only observes the current view after consent discovery and document visibility changes", async () => {
    transport.connection = {};
    transport.record.mockClear();
    const status = Promise.withResolvers<{
      available: boolean;
      consent: string;
      collectionContext: string;
    }>();
    transport.status.mockReturnValueOnce(status.promise);
    const container = document.createElement("div");
    const root = createRoot(container);
    dispose = () => {
      root.unmount();
      container.remove();
    };
    let hidden = true;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    await act(async () => root.render(<View visible environment="remote" />));
    await act(async () =>
      status.resolve({ available: true, consent: "product", collectionContext: "late" }),
    );
    expect(transport.record).not.toHaveBeenCalled();
    hidden = false;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(transport.record).toHaveBeenCalledOnce();
  });
});
