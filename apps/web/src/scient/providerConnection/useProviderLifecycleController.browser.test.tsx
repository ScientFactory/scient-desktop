import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { useLayoutEffect, type ReactNode } from "react";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderConnectionError,
  ProviderInstanceId,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { useProviderLifecycleController } from "./useProviderLifecycleController";

async function _setupFixture0(_fixture: _Fixture) {
  await undefined;
}

async function mount(_fixture: _Fixture, node: ReactNode) {
  if (!_fixture.root0) {
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  await act(async () => await _fixture.root0!.rerender(node));
  return _fixture.host;
}
async function _cleanupFixture1(_fixture: _Fixture) {
  if (_fixture.root0) await act(async () => await _fixture.root0!.unmount());
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  vi.unstubAllGlobals();
}

const start = vi.hoisted(() => vi.fn());
const prepare = vi.hoisted(() => vi.fn());
const planAtom = vi.hoisted(() => Symbol("planProviderRuntime"));
const startAtom = vi.hoisted(() => Symbol("startProviderRuntime"));

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
  async function _setupFixture2(_fixture: _Fixture) {
    prepare
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { ...plan, catalogRevision: "fresh:2" } });
    start.mockReset().mockResolvedValue({ _tag: "Success", value: { providers: [provider] } });
  }
  const controller = async (_fixture: _Fixture) => {
    let result!: ReturnType<typeof useProviderLifecycleController>;
    function Probe() {
      const value = useProviderLifecycleController({ environmentId, provider });
      useLayoutEffect(() => {
        result = value;
      });
      return null;
    }
    await mount(_fixture, <Probe />);
    return result;
  };

  it("starts the selected managed release without a separate version acceptance", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    await (await controller(_fixture)).startRuntime(plan);

    expect(start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, action: "install", catalogRevision: plan.catalogRevision },
    });
  });

  it("preserves the optional legacy acceptance field for older callers", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    await (await controller(_fixture)).startRuntime(plan, { acceptOlderThanSystem: true });

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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    start.mockResolvedValueOnce(stale());
    await (await controller(_fixture)).startRuntime(plan);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    start.mockResolvedValue(stale());
    await expect((await controller(_fixture)).startRuntime(plan)).rejects.toMatchObject({
      reason: "runtime_plan_stale",
    });
    expect(start).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("does not refresh a confirmed removal automatically", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    start.mockResolvedValue(stale());
    await expect(
      (await controller(_fixture)).startRuntime({ ...plan, action: "remove" }),
    ).rejects.toMatchObject({
      reason: "runtime_plan_stale",
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not retry other failures", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    start.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("Runtime is busy.")) });
    await expect((await controller(_fixture)).startRuntime(plan)).rejects.toThrow(
      "Runtime is busy.",
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
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
