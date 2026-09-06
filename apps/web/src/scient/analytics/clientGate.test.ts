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

  it("keeps environments and consent generations separate without replay", async () => {
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
    gate.beginControl(first);
    gate.record(first, event);
    gate.endControl(first, { available: true, consent: "product" });
    gate.record(first, event);
    await tick();
    expect(record).toHaveBeenCalledTimes(3);
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

  it("does not let stale discovery or deferred sends bypass a consent change", async () => {
    let resolve!: (status: ScientAnalyticsStatus) => void;
    const status = vi.fn(
      () =>
        new Promise<ScientAnalyticsStatus>((done) => {
          resolve = done;
        }),
    );
    const record = vi.fn(async () => undefined);
    const gate = createAnalyticsClientGate({ status, record });
    const connection = {};
    gate.prime(connection);
    gate.beginControl(connection);
    gate.endControl(connection, { available: true, consent: "off" });
    resolve({ available: true, consent: "product" });
    await tick();
    gate.record(connection, event);
    gate.endControl(connection, { available: true, consent: "product" });
    gate.record(connection, event);
    gate.beginControl(connection);
    await tick();
    expect(record).not.toHaveBeenCalled();
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
  it("recovers failed consent/deletion controls on later activity without replay", async () => {
    let now = 0;
    const status = vi.fn(async (): Promise<ScientAnalyticsStatus> => ({
      available: true,
      consent: "product",
      collectionContext: "context-1",
    }));
    const record = vi.fn(async () => undefined);
    const gate = createAnalyticsClientGate({ status, record, now: () => now });
    const connection = {};
    await gate.readStatus(connection);
    const old = gate.beginOperation(connection, "pdf-export");
    gate.beginControl(connection);
    gate.endControl(connection);
    old("completed");
    for (let i = 0; i < 1000; i += 1) gate.record(connection, event);
    await tick();
    expect(record).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledOnce();
    now = 60_000;
    const uncertain = gate.beginOperation(connection, "pdf-export");
    await tick();
    uncertain("completed");
    expect(record).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(2);
    gate.beginOperation(connection, "pdf-export")("completed");
    await tick();
    expect(record).toHaveBeenCalledTimes(2);
    gate.beginControl(connection);
    gate.endControl(connection, { available: true, consent: "off" });
    now = 3_600_000;
    gate.beginOperation(connection, "pdf-export")("completed");
    await tick();
    expect(status).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
  });

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
    const status = vi.fn(async (): Promise<ScientAnalyticsStatus> => ({
      available: true,
      consent: "product",
    }));
    const gate = createAnalyticsClientGate({ status, record });
    const connection = {};
    const unknown = gate.beginOperation(connection, "pdf-export");
    await tick();
    unknown("completed");
    gate.beginOperation(connection, "pdf-export")("failed");
    gate.endControl(connection, { available: true, consent: "off" });
    const off = gate.beginOperation(connection, "pdf-export");
    gate.endControl(connection, {
      available: true,
      consent: "product",
      collectionContext: "enabled",
    });
    off("completed");
    await tick();
    expect(record).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledOnce();
  });

  it("fences in-flight work after local controls and a newly observed remote context", async () => {
    let context = "context-1";
    const record = vi.fn(async () => undefined);
    const gate = createAnalyticsClientGate({
      status: async () => ({ available: true, consent: "product", collectionContext: context }),
      record,
    });
    const connection = {};
    await gate.readStatus(connection);
    const local = gate.beginOperation(connection, "pdf-export");
    gate.beginControl(connection);
    gate.endControl(connection, {
      available: true,
      consent: "product",
      collectionContext: "context-2",
    });
    local("completed");
    await tick();
    expect(record).not.toHaveBeenCalled();
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
