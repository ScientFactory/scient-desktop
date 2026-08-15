import { describe, expect, it } from "vite-plus/test";

import { createPlotlyWebGlActivityPool } from "./plotlyWebGlActivityPool";

describe("Plotly WebGL activity pool", () => {
  it("keeps the two most recently requested figures active and restores evicted figures", () => {
    const pool = createPlotlyWebGlActivityPool(2);
    const events: string[] = [];
    const registrations = ["a", "b", "c"].map((name) =>
      pool.register({
        activate: () => events.push(`${name}:activate`),
        deactivate: () => events.push(`${name}:deactivate`),
      }),
    );

    registrations[0]?.setNearViewport(true);
    registrations[1]?.setNearViewport(true);
    registrations[2]?.setNearViewport(true);

    expect(events).toEqual(["a:activate", "b:activate", "a:deactivate", "c:activate"]);

    registrations[1]?.setNearViewport(false);
    registrations[0]?.setNearViewport(true);

    expect(events).toEqual([
      "a:activate",
      "b:activate",
      "a:deactivate",
      "c:activate",
      "b:deactivate",
      "a:activate",
    ]);
  });

  it("releases an active expanded figure when it unregisters", () => {
    const pool = createPlotlyWebGlActivityPool(2);
    const deactivate: boolean[] = [];
    const registration = pool.register({
      activate: () => undefined,
      deactivate: () => deactivate.push(true),
    });

    registration.setNearViewport(true);
    registration.unregister();

    expect(deactivate).toHaveLength(1);
  });
});
