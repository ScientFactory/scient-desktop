import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  providerOnboardingStatusLabel,
  readyProviderDefaultModel,
} from "./ProviderOnboardingPicker";

const INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

function entry(input: {
  readonly status: ServerProvider["status"];
  readonly models: ServerProvider["models"];
}) {
  return deriveProviderInstanceEntries([
    {
      instanceId: INSTANCE_ID,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: "2.1.170",
      status: input.status,
      auth: { status: "authenticated", required: true },
      checkedAt: "2026-08-09T00:00:00.000Z",
      models: input.models,
      slashCommands: [],
      skills: [],
    },
  ])[0];
}

describe("readyProviderDefaultModel", () => {
  it("prefers the provider's declared non-custom default", () => {
    expect(
      readyProviderDefaultModel(
        entry({
          status: "ready",
          models: [
            {
              slug: "custom-model",
              name: "Custom",
              isCustom: true,
              capabilities: null,
            },
            {
              slug: "claude-sonnet",
              name: "Claude Sonnet",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
        }),
      ),
    ).toBe("claude-sonnet");
  });

  it("does not hand an unready provider to the composer", () => {
    expect(
      readyProviderDefaultModel(
        entry({
          status: "warning",
          models: [
            {
              slug: "claude-sonnet",
              name: "Claude Sonnet",
              isCustom: false,
              capabilities: null,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("labels only a usable provider as ready", () => {
    const readyEntry = entry({
      status: "ready",
      models: [
        {
          slug: "claude-sonnet",
          name: "Claude Sonnet",
          isCustom: false,
          capabilities: null,
        },
      ],
    });
    const incompleteEntry = entry({
      status: "warning",
      models: [
        {
          slug: "claude-sonnet",
          name: "Claude Sonnet",
          isCustom: false,
          capabilities: null,
        },
      ],
    });

    expect(providerOnboardingStatusLabel(readyEntry)).toBe("Ready");
    expect(providerOnboardingStatusLabel(incompleteEntry)).toBe("Needs attention");
  });

  it("resolves default model for Antigravity when ready", () => {
    const antigravityEntry = deriveProviderInstanceEntries([
      {
        instanceId: ProviderInstanceId.make("antigravity"),
        driver: ProviderDriverKind.make("antigravity"),
        enabled: true,
        installed: true,
        version: "1.1.17",
        status: "ready",
        auth: { status: "authenticated", required: true },
        checkedAt: "2026-08-22T00:00:00.000Z",
        models: [
          {
            slug: "gemini-3.7-flash",
            name: "Gemini 3.7 Flash",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
          {
            slug: "gemini-3.1-pro",
            name: "Gemini 3.1 Pro",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      },
    ])[0];

    expect(readyProviderDefaultModel(antigravityEntry)).toBe("gemini-3.7-flash");
    expect(providerOnboardingStatusLabel(antigravityEntry)).toBe("Ready");
  });
});
