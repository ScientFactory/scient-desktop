import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderConnectionError,
  ProviderInstanceId,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const start = vi.hoisted(() => vi.fn());
const prepare = vi.hoisted(() => vi.fn());
const planAtom = vi.hoisted(() => Symbol("planProviderRuntime"));
const startAtom = vi.hoisted(() => Symbol("startProviderRuntime"));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../localApi", () => ({ ensureLocalApi: vi.fn() }));
vi.mock("../../state/server", () => ({
  serverEnvironment: new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "startProviderRuntime"
          ? startAtom
          : name === "planProviderRuntime"
            ? planAtom
            : Symbol(String(name)),
    },
  ),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === startAtom ? start : atom === planAtom ? prepare : vi.fn(),
}));

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { useProviderLifecycleController } from "./useProviderLifecycleController";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("droid");
const provider = {
  instanceId,
  driver: ProviderDriverKind.make("droid"),
} as ServerProvider;
const plan: ProviderRuntimePlan = {
  instanceId,
  action: "install",
  target: "darwin-arm64",
  version: "0.230.0",
  downloadBytes: null,
  sourceLabel: "Official Factory Droid release",
  catalogRevision: "reviewed:1:older-than-system",
  message: "Scient-managed Droid 0.230.0 is older than your installed Droid 0.231.0.",
  systemVersion: "0.231.0",
  olderThanSystem: true,
};

describe("useProviderLifecycleController runtime start", () => {
  beforeEach(() => {
    hooks.reset();
    prepare
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { ...plan, catalogRevision: "fresh:2" } });
    start.mockReset().mockResolvedValue({ _tag: "Success", value: { providers: [provider] } });
  });
  const controller = () => {
    hooks.beginRender();
    return useProviderLifecycleController({ environmentId, provider });
  };

  it("starts the selected managed release without a separate version acceptance", async () => {
    await controller().startRuntime(plan);

    expect(start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, action: "install", catalogRevision: plan.catalogRevision },
    });
  });

  it("preserves the optional legacy acceptance field for older callers", async () => {
    await controller().startRuntime(plan, { acceptOlderThanSystem: true });

    expect(start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        instanceId,
        action: "install",
        catalogRevision: plan.catalogRevision,
        acceptOlderThanSystem: true,
      },
    });
  });

  const stale = () => ({
    _tag: "Failure",
    cause: Cause.fail(
      new ProviderConnectionError({
        provider: provider.driver,
        instanceId,
        reason: "runtime_plan_stale",
        message: "The catalog changed.",
      }),
    ),
  });

  it("refreshes a stale catalog once and starts the current release", async () => {
    start.mockResolvedValueOnce(stale());
    await controller().startRuntime(plan);
    expect(prepare).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, action: "install" },
    });
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, action: "install", catalogRevision: "fresh:2" },
    });
  });

  it("stops if the refreshed plan is also stale", async () => {
    start.mockResolvedValue(stale());
    await expect(controller().startRuntime(plan)).rejects.toMatchObject({
      reason: "runtime_plan_stale",
    });
    expect(start).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("does not refresh a confirmed removal automatically", async () => {
    start.mockResolvedValue(stale());
    await expect(controller().startRuntime({ ...plan, action: "remove" })).rejects.toMatchObject({
      reason: "runtime_plan_stale",
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not retry other failures", async () => {
    start.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("Runtime is busy.")) });
    await expect(controller().startRuntime(plan)).rejects.toThrow("Runtime is busy.");
    expect(start).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
  });
});
