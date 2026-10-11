import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildServerProvider,
  retainUnavailableAgentModels,
} from "@t3tools/provider-core/server/snapshotProbe";

const model = (slug: string): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: null,
});
const snapshot = (
  models: ReadonlyArray<ServerProviderModel>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  ...buildServerProvider({
    presentation: { displayName: "Test" },
    enabled: true,
    checkedAt: "2026-10-02T00:00:00Z",
    models,
    probe: { installed: true, version: "18.2.8", status: "ready", auth: { status: "unknown" } },
  }),
  instanceId: ProviderInstanceId.make("omp"),
  driver: ProviderDriverKind.make("omp"),
  ...overrides,
});

describe("native agent catalog refresh", () => {
  it.each(["omp", "pi", "scient"])(
    "retains removed %s models for Settings and clears their default",
    (kind) => {
      const identity = {
        driver: ProviderDriverKind.make(kind),
        instanceId: ProviderInstanceId.make(kind),
      };
      const previous = snapshot(
        [{ ...model("anthropic/claude"), isDefault: true }, model("local/model")],
        identity,
      );
      const refreshed = retainUnavailableAgentModels(
        previous,
        snapshot([model("local/model")], identity),
      );
      expect(refreshed.models).toHaveLength(2);
      expect(refreshed.models[1]).toMatchObject({
        slug: "anthropic/claude",
        isDefault: false,
        unavailableReason: expect.any(String),
      });
      const recovered = retainUnavailableAgentModels(refreshed, previous);
      expect(recovered.models).toEqual(previous.models);
    },
  );
  it("does not infer a denial from a failed probe", () => {
    const previous = snapshot([model("anthropic/claude")]);
    expect(
      retainUnavailableAgentModels(previous, snapshot([], { status: "error", version: null }))
        .models,
    ).toEqual(previous.models);
  });
  it("clears remembered models after a confirmed runtime version change", () => {
    const next = snapshot([], { version: "18.3.1" });
    expect(retainUnavailableAgentModels(snapshot([model("local/model")]), next)).toBe(next);
  });
  it("retains a removed model even when the native catalog becomes empty", () => {
    expect(
      retainUnavailableAgentModels(
        snapshot([model("local/model")]),
        snapshot([], { status: "warning" }),
      ).models[0]?.unavailableReason,
    ).toBeDefined();
  });
  it("does not carry access state between instances or across drivers", () => {
    const previous = snapshot([model("anthropic/claude")]);
    for (const overrides of [
      { instanceId: ProviderInstanceId.make("omp_work") },
      { driver: ProviderDriverKind.make("codex") },
    ]) {
      const next = snapshot([], overrides);
      expect(retainUnavailableAgentModels(previous, next)).toBe(next);
    }
  });
});
