import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render as renderUi } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";
const favoritesAtom = Atom.make<
  ReadonlyArray<{
    provider: ProviderInstanceId;
    model: string;
  }>
>([]).pipe(Atom.keepAlive);
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentModelPreferences: () => ({
    favorites: useAtomValue(favoritesAtom),
    providerModelPreferences: {},
  }),
  useToggleEnvironmentModelFavorite: () => {
    const setFavorites = useAtomSet(favoritesAtom);
    return async (provider: ProviderInstanceId, model: string) => {
      setFavorites((favorites) =>
        favorites.filter((favorite) => favorite.provider !== provider || favorite.model !== model),
      );
    };
  },
}));
function providerEntry(instanceId: string, driver: string) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
    },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

// Returns the trigger's visible text, which is what the user reads before opening the picker.
async function triggerText(node: ReactNode, inspectMarkup = false) {
  await using screen = await renderUi(node);
  return inspectMarkup
    ? screen.container.innerHTML
    : (screen.container.querySelector("button")?.textContent ?? "");
}
function renderPicker(input: {
  instanceId: string;
  driver: string;
  model: string;
  options: ReadonlyArray<ModelEsque>;
  includeEntry?: boolean;
  triggerLabel?: string;
  iconOnly?: boolean;
  inspectMarkup?: boolean;
}) {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const entry = providerEntry(input.instanceId, input.driver);
  return triggerText(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={instanceId}
      model={input.model}
      lockedProvider={null}
      instanceEntries={input.includeEntry === false ? [] : [entry]}
      modelOptionsByInstance={new Map([[instanceId, input.options]])}
      onInstanceModelChange={() => {}}
      {...(input.triggerLabel
        ? {
            triggerLabel: input.triggerLabel,
          }
        : {})}
      {...(input.iconOnly
        ? {
            iconOnly: true,
          }
        : {})}
    />,
    input.inspectMarkup,
  );
}

describe("ProviderModelPicker", () => {
  it("retains the provider icon and accessible model name while voice hides picker details", async () => {
    const markup = await renderPicker({
      instanceId: "codex",
      driver: "codex",
      model: "gpt-5",
      iconOnly: true,
      inspectMarkup: true,
      options: [
        {
          slug: "gpt-5",
          name: "GPT 5",
          providerCostLabel: "2x",
          isUnavailable: true,
        },
      ],
    });
    expect(markup).toContain('aria-label="GPT 5 (Unavailable)"');
    expect(markup).toContain("relative isolate z-30");
    const trigger = new DOMParser().parseFromString(markup, "text/html").body;
    expect(trigger.querySelector("[data-chat-provider-model-picker-label]")).toBeNull();
    expect(trigger.querySelector("[data-composer-control-chevron]")).toBeNull();
    expect(markup).not.toContain(">2x<");
    expect(markup).not.toContain(">Unavailable<");
  });
});
