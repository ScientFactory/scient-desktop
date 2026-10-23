import { StrictMode } from "react";
import { act, render } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
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

function setup() {
  transport.connection = {};
  transport.requestedEnvironment = null;
  transport.record.mockClear();
  transport.status.mockReset().mockResolvedValue({
    available: true,
    consent: "product",
    collectionContext: "context",
  });
}

describe("analytics view hook lifecycle", () => {
  it("does not recount rerenders or hidden retained editors and routes to the explicit environment", async () => {
    setup();
    // The hook receives its environment directly and has no route dependency.
    await using screen = await render(null, { router: false });
    const show = (visible: boolean) =>
      screen.rerender(
        <StrictMode>
          <View visible={visible} environment="remote" />
        </StrictMode>,
      );
    await show(false);
    expect(transport.record).not.toHaveBeenCalled();
    await show(true);
    for (let i = 0; i < 100; i++) await show(true);
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
    await show(false);
    await show(true);
    expect(transport.record).toHaveBeenCalledTimes(2);
    transport.connection = {};
    await show(true);
    expect(transport.record).toHaveBeenCalledTimes(3);
  });

  it("only observes the current view after consent discovery and document visibility changes", async () => {
    setup();
    const status = Promise.withResolvers<{
      available: boolean;
      consent: string;
      collectionContext: string;
    }>();
    transport.status.mockReturnValueOnce(status.promise);
    // The hook receives its environment directly and has no route dependency.
    await using screen = await render(null, { router: false });
    let hidden = true;
    using _visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => (hidden ? "hidden" : "visible"));
    await screen.rerender(<View visible environment="remote" />);
    await act(async () =>
      status.resolve({ available: true, consent: "product", collectionContext: "late" }),
    );
    expect(transport.record).not.toHaveBeenCalled();
    hidden = false;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(transport.record).toHaveBeenCalledOnce();
  });
});
