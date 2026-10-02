import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const start = vi.hoisted(() => vi.fn());
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
      get: (_target, name) => (name === "startProviderRuntime" ? startAtom : Symbol(String(name))),
    },
  ),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => (atom === startAtom ? start : vi.fn()),
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
    start.mockReset().mockResolvedValue({ _tag: "Success", value: { providers: [provider] } });
  });
  const controller = () => {
    hooks.beginRender();
    return useProviderLifecycleController({ environmentId, provider });
  };

  it("starts a plan without accepting an older release on the user's behalf", async () => {
    await controller().startRuntime(plan);

    expect(start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, action: "install", catalogRevision: plan.catalogRevision },
    });
  });

  it("says the user accepted the older release only when the caller does", async () => {
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
});
