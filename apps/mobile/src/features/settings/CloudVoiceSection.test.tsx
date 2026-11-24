import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { EnvironmentPresentation } from "../../state/environments";
import { CloudVoiceChoice } from "./CloudVoiceSection";

const state = vi.hoisted(() => ({
  canManage: false,
  openrouter: undefined as boolean | undefined,
  children: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("react-native", () => ({
  ScrollView: state.children,
  View: state.children,
  TextInput: () => null,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "connection" ? {} : AsyncResult.success({ openrouter: state.openrouter }),
  useAtomRefresh: () => () => {},
}));
vi.mock("../voice-input/voiceDestination", () => ({
  cloudVoiceConnectionAtom: () => "connection",
  cloudVoiceKeysAtom: () => "keys",
  cloudVoiceModelsAtom: () => "models",
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.canManage }));
vi.mock("../../components/ui/Sheet", () => ({ Sheet: state.children }));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: state.children }));
vi.mock("../../components/ui/ListActionRow", () => ({ ListActionRow: () => null }));
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: ({
    label,
    description,
    disabled,
  }: {
    label: string;
    description?: string;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} aria-label={label}>
      {description}
    </button>
  ),
}));
vi.mock("../../components/ui/Chip", () => ({ Chip: state.children }));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: state.children }));

it.each([
  { canManage: true, key: false, description: "Reconnect · API key required", disabled: false },
  {
    canManage: false,
    key: false,
    description: "Ask the person who manages Lab to add a key",
    disabled: true,
  },
  {
    canManage: true,
    key: undefined,
    description: "Update the environment to use this provider",
    disabled: true,
  },
])(
  "shows the repair available for OpenRouter ($canManage, $key)",
  ({ canManage, key, description, disabled }) => {
    state.canManage = canManage;
    state.openrouter = key;
    const environmentId = EnvironmentId.make("lab");
    const environment = { environmentId, label: "Lab" } as EnvironmentPresentation;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <CloudVoiceChoice
            environment={environment}
            active={{ kind: "cloud", environmentId, provider: "openrouter", model: "acme/voice" }}
            open
            onOpenChange={() => {}}
          />,
        ),
      );
      const outer = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Cloud provider"]',
      )!;
      const provider = container.querySelector<HTMLButtonElement>(
        'button[aria-label="OpenRouter"]',
      )!;
      expect(outer.textContent).toBe(
        key === false ? "OpenRouter · Reconnect" : "OpenRouter · acme/voice",
      );
      expect(provider.textContent).toBe(description);
      expect(provider.disabled).toBe(disabled);
    } finally {
      act(() => root.unmount());
    }
  },
);
