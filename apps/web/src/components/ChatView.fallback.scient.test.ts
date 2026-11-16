import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { resolveUsageLimitContinueWith } from "./ChatView.logic";

it("keeps the resume action when a saved fallback is a model alias", () => {
  const instanceId = ProviderInstanceId.make("antigravity");
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: true,
    status: "ready",
    version: null,
    auth: { status: "authenticated" },
    checkedAt: "2026-11-16T00:00:00Z",
    models: [
      {
        slug: "gemini-4-hydrogen",
        name: "Gemini 4 Hydrogen",
        aliases: ["antigravity-default"],
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };
  const selection = { instanceId, model: "antigravity-default" };
  expect(
    resolveUsageLimitContinueWith({
      currentSelection: { instanceId, model: "gemini-4-argon" },
      fallbackSelection: selection,
      providers: [provider],
      now: Date.parse(provider.checkedAt),
    }),
  ).toEqual({ selection, modelName: "Gemini 4 Hydrogen" });
});
