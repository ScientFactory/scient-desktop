import { describe, expect, it, vi } from "vite-plus/test";
import type { ScientAnalyticsStatus, ScientAnalyticsUiEvent } from "@t3tools/contracts";
import { createAnalyticsClientGate } from "./clientGate";

const event: ScientAnalyticsUiEvent = {
  name: "surface.opened",
  properties: { surface: "settings" },
};
const tick = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("UI analytics gate", () => {
  it("observes only the current visible view after discovery, with no historic replay", async () => {
    let resolve!: (status: ScientAnalyticsStatus) => void;
    let next: ScientAnalyticsStatus | null = null;
    const record = vi.fn(async () => undefined);
    const gate = createAnalyticsClientGate({
      status: () =>
        next === null
          ? new Promise<ScientAnalyticsStatus>((done) => {
              resolve = done;
            })
          : Promise.resolve(next),
      record,
    });
    const connection = {};
    let visible = true;
    const view = gate.observeView(connection, () =>
      visible ? { name: "panel.viewed", properties: { category: "browser" } } : null,
    );
    await tick();
    visible = false;
    resolve({ available: true, consent: "product", collectionContext: "first" });
    await tick();
    expect(record).not.toHaveBeenCalled();
    visible = true;
    view.refresh();
    view.refresh();
    await tick();
    expect(record).toHaveBeenCalledOnce();
    next = { available: true, consent: "off" };
    await gate.readStatus(connection);
    next = { available: true, consent: "product", collectionContext: "second" };
    await gate.readStatus(connection);
    await tick();
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]).toEqual([
      connection,
      { name: "panel.viewed", properties: { category: "browser" }, collectionContext: "second" },
    ]);
    view.dispose();
  });
  it("does not send views disposed before discovery or strict-mode effect restart", async () => {
    const record = vi.fn(async () => undefined);
    const status = vi.fn(async () => ({
      available: true,
      consent: "product" as const,
      collectionContext: "current",
    }));
    const gate = createAnalyticsClientGate({ status, record });
    const connection = {};
    gate.observeView(connection, () => event).dispose();
    const active = gate.observeView(connection, () => event);
    await tick();
    expect(record).toHaveBeenCalledOnce();
    active.dispose();
  });
  it("does no event work for Off or Essential views and bounds observers", async () => {
    for (const consent of ["off", "essential"] as const) {
      const record = vi.fn(async () => undefined);
      const gate = createAnalyticsClientGate({
        status: async () => ({ available: true, consent, collectionContext: "current" }),
        record,
      });
      const connection = {};
      const views = Array.from({ length: 100 }, () =>
        gate.observeView(connection, () => ({
          name: "settings.viewed",
          properties: { section: "general" },
        })),
      );
      await tick();
      expect(record).not.toHaveBeenCalled();
      for (const view of views) view.dispose();
    }
  });
  it("coalesces discovery and does no per-event HTTP work while Off", async () => {
    const status = vi.fn(async (): Promise<ScientAnalyticsStatus> => ({
      available: true,
      consent: "off",
    }));
    const record = vi.fn(async () => undefined);
    const gate = createAnalyticsClientGate({ status, record });
    const connection = {};
    for (let i = 0; i < 1000; i += 1) gate.record(connection, event);
    await tick();
    for (let i = 0; i < 1000; i += 1) gate.record(connection, event);
    expect(status).toHaveBeenCalledOnce();
    expect(record).not.toHaveBeenCalled();
  });

  it("keeps environments separate without replay", async () => {
    const status = vi.fn(async (): Promise<ScientAnalyticsStatus> => ({
      available: true,
      consent: "product",
    }));
    const record = vi.fn(async () => undefined);
    const gate = createAnalyticsClientGate({ status, record });
    const first = {};
    const second = {};
    gate.record(first, event);
    await tick();
    expect(record).not.toHaveBeenCalled();
    gate.prime(second);
    await tick();
    gate.record(first, event);
    gate.record(first, event);
    gate.record(second, event);
    await tick();
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("recovers failed discovery on later activity without a timer or a retry storm", async () => {
    let now = 0;
    const status = vi
      .fn<() => Promise<ScientAnalyticsStatus>>()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue({ available: true, consent: "product" });
    const record = vi.fn(async () => undefined);
    const gate = createAnalyticsClientGate({ status, record, now: () => now });
    const connection = {};
    gate.prime(connection);
    await tick();
    for (let i = 0; i < 1000; i += 1) gate.record(connection, event);
    await tick();
    expect(status).toHaveBeenCalledOnce();
    expect(record).not.toHaveBeenCalled();
    now = 60_000;
    gate.record(connection, event);
    await tick();
    expect(status).toHaveBeenCalledTimes(2);
    expect(record).not.toHaveBeenCalled();
    gate.record(connection, event);
    await tick();
    expect(record).toHaveBeenCalledOnce();
  });

  it("bounds in-flight work and isolates even synchronously throwing transports", async () => {
    const status = async (): Promise<ScientAnalyticsStatus> => ({
      available: true,
      consent: "product",
    });
    const record = vi.fn(() => new Promise<void>(() => {}));
    const gate = createAnalyticsClientGate({ status, record });
    const connection = {};
    await gate.readStatus(connection);
    for (let i = 0; i < 1000; i += 1)
      gate.record(connection, { name: "project.opened", properties: {} });
    await tick();
    expect(record).toHaveBeenCalledTimes(20);
    const throwing = createAnalyticsClientGate({
      status,
      record: () => {
        throw new Error("transport");
      },
    });
    await throwing.readStatus(connection);
    expect(() => throwing.record(connection, event)).not.toThrow();
    await tick();
  });
});

describe("UI operation outcomes", () => {
  it("drops a saturated start without inventing a later completion", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = vi.fn(() => pending);
    const gate = createAnalyticsClientGate({
      status: async () => ({ available: true, consent: "product", collectionContext: "context-1" }),
      record,
    });
    const connection = {};
    await gate.readStatus(connection);
    for (let i = 0; i < 20; i += 1)
      gate.record(connection, { name: "project.opened", properties: {} });
    const finish = gate.beginOperation(connection, "pdf-export");
    await tick();
    expect(record).toHaveBeenCalledTimes(20);
    release();
    await tick();
    finish("completed");
    await tick();
    expect(record).toHaveBeenCalledTimes(20);
  });

  it("preserves a long-running outcome without an extra discovery request or duplicate completion", async () => {
    let now = 100;
    const status = vi.fn(async (): Promise<ScientAnalyticsStatus> => ({
      available: true,
      consent: "product",
      collectionContext: "context-1",
    }));
    const record = vi.fn<(connection: object, event: ScientAnalyticsUiEvent) => Promise<void>>(
      async () => undefined,
    );
    const gate = createAnalyticsClientGate({ status, record, now: () => now });
    const connection = {};
    await gate.readStatus(connection);
    const finish = gate.beginOperation(connection, "pdf-export");
    await tick();
    now = 120_100;
    finish("completed");
    finish("failed");
    await tick();
    expect(status).toHaveBeenCalledOnce();
    expect(record.mock.calls.map((call) => call[1])).toEqual([
      {
        name: "scient.operation.started",
        properties: { operationKind: "pdf-export", trigger: "user" },
        collectionContext: "context-1",
      },
      {
        name: "scient.operation.completed",
        properties: {
          operationKind: "pdf-export",
          trigger: "user",
          durationMs: 120_000,
          failureClass: "unknown",
        },
        collectionContext: "context-1",
      },
    ]);
  });

  it("never reconstructs operations begun before consent discovery or on an old server", async () => {
    const record = vi.fn(async () => undefined);
    let current: ScientAnalyticsStatus = { available: true, consent: "product" };
    const status = vi.fn(async () => current);
    const gate = createAnalyticsClientGate({ status, record });
    const connection = {};
    const unknown = gate.beginOperation(connection, "pdf-export");
    await tick();
    unknown("completed");
    gate.beginOperation(connection, "pdf-export")("failed");
    current = { available: true, consent: "off" };
    await gate.readStatus(connection);
    const off = gate.beginOperation(connection, "pdf-export");
    current = { available: true, consent: "product", collectionContext: "enabled" };
    await gate.readStatus(connection);
    off("completed");
    await tick();
    expect(record).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(3);
  });

  it("fences in-flight work after a newly observed remote context", async () => {
    let context = "context-1";
    const record = vi.fn(async () => undefined);
    const gate = createAnalyticsClientGate({
      status: async () => ({ available: true, consent: "product", collectionContext: context }),
      record,
    });
    const connection = {};
    await gate.readStatus(connection);
    const remote = gate.beginOperation(connection, "pdf-export");
    await tick();
    context = "context-3";
    await gate.readStatus(connection);
    remote("failed");
    await tick();
    expect(record).toHaveBeenCalledOnce();
  });

  it("retains only failures at Essential and never labels unconfirmed downloads successful", async () => {
    const record = vi.fn<(connection: object, event: ScientAnalyticsUiEvent) => Promise<void>>(
      async () => undefined,
    );
    const gate = createAnalyticsClientGate({
      status: async () => ({
        available: true,
        consent: "essential",
        collectionContext: "context-1",
      }),
      record,
    });
    const connection = {};
    await gate.readStatus(connection);
    for (const outcome of ["completed", "cancelled", null, "failed"] as const)
      gate.beginOperation(connection, "document-export")(outcome);
    await tick();
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[1].name).toBe("scient.operation.failed");
  });
});
