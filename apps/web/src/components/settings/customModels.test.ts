import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  type ModelConnectionReadiness,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  connectionKeyMissing,
  CUSTOM_MODEL_PRESETS,
  customModelPresetId,
  defaultModelAgents,
  droidDefaultReasoningLevels,
  droidDefaultReasoningNote,
  droidReasoningNote,
  MISSING_KEY_STATUS,
  modelConnectionStatus,
  modelTestAgents,
  modelTestGuidance,
  modelUnavailableHint,
  namedTestFailure,
} from "./customModels";

const provider = {
  enabled: true,
  installed: true,
  probePending: false,
  status: "ready",
  auth: { status: "unknown" },
} satisfies Pick<ServerProvider, "enabled" | "installed" | "probePending" | "status" | "auth">;
const available: ModelConnectionReadiness = {
  connectionId: "c",
  modelId: "m",
  configurationKey: "key",
  state: "available",
  source: "agent",
};

describe("model connection presentation", () => {
  it("does not confuse unreported limits with an unavailable agent-native model", () => {
    expect(modelConnectionStatus(provider, available)).toBeUndefined();
    expect(modelConnectionStatus(provider, { ...available, state: "needs_setup" })).toBe(
      "Needs setup",
    );
    expect(modelConnectionStatus(provider, undefined)).toBe("Checking");
    expect(modelConnectionStatus({ ...provider, probePending: true }, available)).toBe("Checking");
  });
  it("knows a connection's key is missing whatever else the reporting agent's status says", () => {
    const missing = {
      ...available,
      connectionId: "lab",
      state: "needs_setup",
      reason: "credential",
    } satisfies ModelConnectionReadiness;
    // An agent that is also signed out is labelled by that, not by the key.
    const signedOut = {
      ...provider,
      auth: { status: "unauthenticated" as const },
      modelConnections: [missing],
    };
    expect(modelConnectionStatus(signedOut, missing)).toBe("Check agent");
    expect(connectionKeyMissing([signedOut], "lab")).toBe(true);
    const failing = { ...signedOut, status: "error" as const };
    expect(modelConnectionStatus(failing, missing)).toBe("Check agent");
    expect(connectionKeyMissing([failing], "lab")).toBe(true);
    expect(connectionKeyMissing([signedOut], "other")).toBe(false);
    expect(
      connectionKeyMissing(
        [{ ...provider, modelConnections: [{ ...available, connectionId: "lab" }] }],
        "lab",
      ),
    ).toBe(false);
    expect(connectionKeyMissing(undefined, "lab")).toBe(false);
  });
  it("says a saved key is missing instead of a generic setup state", () => {
    expect(
      modelConnectionStatus(provider, { ...available, state: "needs_setup", reason: "credential" }),
    ).toBe(MISSING_KEY_STATUS);
    expect(MISSING_KEY_STATUS).toBe("Saved key missing — re-enter it");
  });
  it("distinguishes installation, disabled, authentication and probe failures", () => {
    expect(modelConnectionStatus({ ...provider, enabled: false }, available)).toBe("Disabled");
    expect(modelConnectionStatus({ ...provider, installed: false }, undefined)).toBe(
      "Not installed",
    );
    expect(modelConnectionStatus({ ...provider, status: "error" }, undefined)).toBe("Check agent");
    expect(modelConnectionStatus({ ...provider, status: "error" }, available)).toBe("Check agent");
    expect(
      modelConnectionStatus({ ...provider, auth: { status: "unauthenticated" } }, undefined),
    ).toBe("Check agent");
  });
  it("uses xAI Responses for new connections without rewriting saved completions", () => {
    expect(CUSTOM_MODEL_PRESETS.find((preset) => preset.id === "spacexai")?.protocol).toBe(
      "openai-responses",
    );
    const saved = {
      id: "xai",
      name: "SpaceXAI",
      protocol: "openai-completions" as const,
      baseUrl: "https://api.x.ai/v1",
      credentialId: null,
      models: [],
    };
    expect(customModelPresetId(saved)).toBe("spacexai");
    expect(saved.protocol).toBe("openai-completions");
  });
});

describe("Droid reasoning note", () => {
  it("names the levels Droid offers and the ones it sends only as the default", () => {
    expect(
      droidReasoningNote({
        protocol: "openai-responses",
        mode: "effort",
        modelId: "gpt-5.5",
        levels: ["minimal", "low", "medium", "high", "xhigh"],
      }),
    ).toBe(
      "Droid offers Low, Medium and High for this model, and Minimal or Extra-high only as its default level.",
    );
    // Everything is offered: nothing to explain.
    expect(
      droidReasoningNote({
        protocol: "openai-completions",
        mode: "effort",
        modelId: "local-model",
        levels: ["off", "low", "high"],
      }),
    ).toBeUndefined();
    expect(
      droidReasoningNote({
        protocol: "openai-completions",
        mode: "effort",
        modelId: "local-model",
        levels: [],
      }),
    ).toBeUndefined();
  });
});

describe("Droid reasoning note for Anthropic Messages", () => {
  const note = (modelId: string, levels: ReadonlyArray<string>) =>
    droidReasoningNote({ protocol: "anthropic-messages", mode: "adaptive", modelId, levels });

  it("says Droid offers only Low, Medium and High for a model it does not know as adaptive", () => {
    expect(note("plain-anthropic", ["low", "medium", "high", "max"])).toBe(
      "Droid offers Low, Medium and High for this model. It sends other levels only to the Claude models it knows as adaptive.",
    );
    expect(note("claude-sonnet-4-5", ["minimal", "high", "xhigh"])).toBe(
      "Droid offers High for this model. It sends other levels only to the Claude models it knows as adaptive.",
    );
    // Nothing is withheld: nothing to explain.
    expect(note("plain-anthropic", ["low", "medium", "high"])).toBeUndefined();
  });

  it("names every level Droid sends for an adaptive Claude model", () => {
    expect(note("claude-opus-4-7", ["low", "medium", "high", "xhigh", "max"])).toBeUndefined();
    expect(note("claude-opus-4-6", ["low", "medium", "high", "xhigh", "max"])).toBe(
      "Droid offers Off, Low, Medium, High and Max for this model.",
    );
  });
});

describe("Droid default reasoning level", () => {
  const messages = "anthropic-messages" as const;

  it("lists the levels Droid applies as a model's default", () => {
    const levels = ["minimal", "low", "medium", "high", "xhigh", "max"];
    // Not a Claude model Droid knows as adaptive: budget thinking only.
    expect(
      droidDefaultReasoningLevels({ protocol: messages, modelId: "plain-anthropic", levels }),
    ).toEqual(["low", "medium", "high"]);
    expect(
      droidDefaultReasoningLevels({ protocol: messages, modelId: "claude-opus-4-6", levels }),
    ).toEqual(["low", "medium", "high", "max"]);
    expect(
      droidDefaultReasoningLevels({ protocol: messages, modelId: "claude-opus-4-7", levels }),
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // Effort APIs: Droid sends the configured default, whichever it is.
    expect(
      droidDefaultReasoningLevels({ protocol: "openai-responses", modelId: "any", levels }),
    ).toEqual(levels);
  });

  it("says which level Droid uses for a default it cannot apply", () => {
    const plain = {
      protocol: messages,
      modelId: "plain-anthropic",
      levels: ["low", "medium", "high", "max"],
    };
    expect(droidDefaultReasoningNote({ ...plain, defaultLevel: "max" })).toBe(
      "Droid cannot apply Max to this model and uses Medium instead.",
    );
    // The endpoint's own default is used when Droid applies it.
    expect(
      droidDefaultReasoningNote({ ...plain, defaultLevel: "max", metadataDefault: "high" }),
    ).toBe("Droid cannot apply Max to this model and uses High instead.");
    expect(
      droidDefaultReasoningNote({
        protocol: messages,
        modelId: "claude-opus-4-6",
        levels: ["low", "medium", "high", "xhigh", "max"],
        defaultLevel: "xhigh",
      }),
    ).toBe("Droid cannot apply Extra-high to this model and uses Medium instead.");
    expect(droidDefaultReasoningNote({ ...plain, levels: ["max"], defaultLevel: "max" })).toBe(
      "Droid cannot apply Max to this model and uses no reasoning level.",
    );
    // Applied as chosen, or nothing chosen: nothing to say.
    expect(droidDefaultReasoningNote({ ...plain, defaultLevel: "high" })).toBeUndefined();
    expect(droidDefaultReasoningNote({ ...plain, defaultLevel: undefined })).toBeUndefined();
    expect(
      droidDefaultReasoningNote({
        protocol: "openai-responses",
        modelId: "any",
        levels: ["low", "xhigh"],
        defaultLevel: "xhigh",
      }),
    ).toBeUndefined();
  });
});

describe("custom model agents", () => {
  const agent = (id: string) => ({ id: ProviderInstanceId.make(id), name: id });
  const agents = [agent("pi"), agent("droid"), agent("omp"), agent("droid_work")];
  const enabled = new Set(["droid", "omp"]);
  const isEnabled = (id: ProviderInstanceId) => enabled.has(id);

  it("attaches a new model to enabled agents, or only to the agent it was opened from", () => {
    expect(defaultModelAgents({ agents, isEnabled })).toEqual(["droid", "omp"]);
    expect(
      defaultModelAgents({ agents, isEnabled, openedFrom: ProviderInstanceId.make("droid_work") }),
    ).toEqual(["droid_work"]);
    // An agent that is not in the list (not eligible) is ignored.
    expect(
      defaultModelAgents({ agents, isEnabled, openedFrom: ProviderInstanceId.make("codex") }),
    ).toEqual(["droid", "omp"]);
  });

  it("tests through enabled attached agents, the opening agent first", () => {
    const attached = ["pi", "omp", "droid"].map((id) => ProviderInstanceId.make(id));
    expect(modelTestAgents({ agents, attached, isEnabled }).map((a) => a.id)).toEqual([
      "droid",
      "omp",
    ]);
    expect(
      modelTestAgents({
        agents,
        attached,
        isEnabled,
        openedFrom: ProviderInstanceId.make("omp"),
      }).map((a) => a.id),
    ).toEqual(["omp", "droid"]);
    expect(
      modelTestAgents({ agents, attached: [ProviderInstanceId.make("pi")], isEnabled }),
    ).toEqual([]);
  });
});

describe("model availability hint", () => {
  it("points to the model ID only for agents that list models by it", () => {
    expect(modelUnavailableHint("pi")).toBe(" — check the model ID and limits in Edit");
    expect(modelUnavailableHint("omp")).toBe(" — check the model ID and limits in Edit");
    // Droid lists every model Scient gives it; an absent one means its list is out of date.
    expect(modelUnavailableHint("droid")).toBe(" — use Check again to refresh Droid's list");
  });
});

describe("Test result", () => {
  it("always names the agent the Test ran through", () => {
    // Failures before any request (missing key, stale catalog, RPC failure) carry no agent.
    expect(namedTestFailure("Droid", "Re-enter the API key for Lab in Custom models.")).toBe(
      "Droid: Re-enter the API key for Lab in Custom models.",
    );
    expect(namedTestFailure("Droid work", "Could not complete this action. Try again.")).toBe(
      "Droid work: Could not complete this action. Try again.",
    );
    // The server already names the agent for failures of the request itself.
    expect(namedTestFailure("Droid", "Droid: No response within 45 s.")).toBe(
      "Droid: No response within 45 s.",
    );
  });
});

describe("Test guidance", () => {
  it("says how to make a model testable when no enabled agent is attached", () => {
    expect(modelTestGuidance(["Pi", "Droid", "Agent Three"])).toBe(
      "To test this model, select an enabled agent under Use with (Edit): Pi, Droid or Agent Three.",
    );
    expect(modelTestGuidance(["Droid"])).toBe(
      "To test this model, select an enabled agent under Use with (Edit): Droid.",
    );
    expect(modelTestGuidance([])).toBe(
      "To test this model, enable an agent that supports custom models and select it under Use with (Edit).",
    );
  });
});
