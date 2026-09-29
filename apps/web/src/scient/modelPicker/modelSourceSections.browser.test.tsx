import "../../index.css";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { ModelPickerContent } from "../../components/chat/ModelPickerContent";
import type { ModelEsque } from "../../components/chat/providerIconUtils";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { COLLAPSED_MODEL_SOURCES_STORAGE_KEY } from "./modelSourceSections";

const instanceId = ProviderInstanceId.make("omp");

function ompEntry() {
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("omp"),
    displayName: "Oh My Pi",
    enabled: true,
    installed: true,
    version: "18.3.1",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-09-29T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

const ACCOUNT_AND_CUSTOM: ReadonlyArray<ModelEsque> = [
  { slug: "anthropic/opus", name: "Claude Opus", subProvider: "anthropic" },
  { slug: "openai-codex/gpt", name: "GPT Sol", subProvider: "openai-codex" },
  { slug: "anthropic/sonnet", name: "Claude Sonnet", subProvider: "anthropic" },
  { slug: "scient_openrouter/glm", name: "GLM Flash", subProvider: "OpenRouter" },
  { slug: "scient_local/qwen", name: "Qwen Local", subProvider: "Local" },
];

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function renderPicker(input: {
  readonly options: ReadonlyArray<ModelEsque>;
  readonly model: string;
  readonly onChange?: (instance: ProviderInstanceId, model: string) => void;
}) {
  root?.unmount();
  host?.remove();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <ModelPickerContent
      activeInstanceId={instanceId}
      model={input.model}
      lockedProvider={null}
      instanceEntries={[ompEntry()]}
      modelOptionsByInstance={new Map([[instanceId, input.options]])}
      terminalOpen={false}
      onInstanceModelChange={input.onChange ?? (() => {})}
    />,
  );
}

const text = () => host?.textContent ?? "";
const header = (label: string) =>
  [...(host?.querySelectorAll<HTMLElement>("[aria-expanded]") ?? [])].find((element) =>
    element.textContent?.includes(label),
  );

beforeEach(async () => {
  window.localStorage.removeItem(COLLAPSED_MODEL_SOURCES_STORAGE_KEY);
  await page.viewport(1280, 900);
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  window.localStorage.removeItem(COLLAPSED_MODEL_SOURCES_STORAGE_KEY);
});

describe("Oh My Pi model picker sections", () => {
  it("shows both sections, collapses one, remembers it, and lets search reach it", async () => {
    renderPicker({ options: ACCOUNT_AND_CUSTOM, model: "scient_local/qwen" });
    await expect.poll(() => header("Your Oh My Pi accounts")).toBeTruthy();
    expect(header("Scient custom models")).toBeTruthy();
    for (const name of ["Claude Opus", "Claude Sonnet", "GPT Sol", "GLM Flash", "Qwen Local"]) {
      expect(text()).toContain(name);
    }
    // Account models are grouped by provider: both Anthropic models come first.
    expect(text().indexOf("Claude Sonnet")).toBeLessThan(text().indexOf("GPT Sol"));
    expect(header("Your Oh My Pi accounts")?.getAttribute("aria-expanded")).toBe("true");

    header("Your Oh My Pi accounts")!.click();
    await expect.poll(() => text().includes("Claude Opus")).toBe(false);
    expect(text()).toContain("Qwen Local");
    expect(header("Your Oh My Pi accounts")?.getAttribute("aria-expanded")).toBe("false");
    expect(header("Your Oh My Pi accounts")?.textContent).toContain("3 models");
    expect(window.localStorage.getItem(COLLAPSED_MODEL_SOURCES_STORAGE_KEY)).toContain(
      "model-source:accounts:omp",
    );

    // A fresh picker keeps the section collapsed.
    renderPicker({ options: ACCOUNT_AND_CUSTOM, model: "scient_local/qwen" });
    await expect.poll(() => header("Your Oh My Pi accounts")).toBeTruthy();
    expect(text()).not.toContain("Claude Opus");

    // Search lists plain matches, including collapsed ones, without headers.
    await userEvent.type(host!.querySelector("input")!, "sonnet");
    await expect.poll(() => text().includes("Claude Sonnet")).toBe(true);
    expect(header("Your Oh My Pi accounts")).toBeUndefined();

    await userEvent.clear(host!.querySelector("input")!);
    await expect.poll(() => header("Your Oh My Pi accounts")).toBeTruthy();
    header("Your Oh My Pi accounts")!.click();
    await expect.poll(() => text().includes("Claude Opus")).toBe(true);
    expect(window.localStorage.getItem(COLLAPSED_MODEL_SOURCES_STORAGE_KEY)).not.toContain(
      "model-source:accounts:omp",
    );
  });

  it("opens the section holding the selected model, then collapses it on request", async () => {
    window.localStorage.setItem(
      COLLAPSED_MODEL_SOURCES_STORAGE_KEY,
      JSON.stringify(["model-source:custom:omp"]),
    );
    renderPicker({ options: ACCOUNT_AND_CUSTOM, model: "scient_openrouter/glm" });
    await expect.poll(() => header("Scient custom models")).toBeTruthy();
    expect(text()).toContain("GLM Flash");
    expect(header("Scient custom models")?.getAttribute("aria-expanded")).toBe("true");

    header("Scient custom models")!.click();
    await expect.poll(() => text().includes("GLM Flash")).toBe(false);
    expect(header("Scient custom models")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("selects a model from a section and never selects a header", async () => {
    const onChange = vi.fn();
    renderPicker({ options: ACCOUNT_AND_CUSTOM, model: "anthropic/opus", onChange });
    await expect.poll(() => header("Scient custom models")).toBeTruthy();
    header("Scient custom models")!.click();
    header("Scient custom models")!.click();
    expect(onChange).not.toHaveBeenCalled();

    const row = [...host!.querySelectorAll<HTMLElement>("[role=option]")].find(
      (element) =>
        element.textContent?.includes("GLM Flash") && !element.hasAttribute("aria-expanded"),
    );
    row!.click();
    await expect.poll(() => onChange.mock.calls.length).toBe(1);
    expect(onChange).toHaveBeenCalledWith(instanceId, "scient_openrouter/glm");
  });

  it("toggles a highlighted header with Enter", async () => {
    renderPicker({ options: ACCOUNT_AND_CUSTOM, model: "anthropic/opus" });
    await expect.poll(() => header("Your Oh My Pi accounts")).toBeTruthy();
    const input = host!.querySelector("input")!;
    input.focus();
    // The first row is the accounts header.
    await userEvent.keyboard("{Home}");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => text().includes("Claude Opus")).toBe(false);
  });

  it("shows a plain list when an instance has only one kind of model", async () => {
    renderPicker({ options: ACCOUNT_AND_CUSTOM.slice(0, 3), model: "anthropic/opus" });
    await expect.poll(() => text().includes("Claude Opus")).toBe(true);
    expect(header("Your Oh My Pi accounts")).toBeUndefined();
    expect(header("Scient custom models")).toBeUndefined();
  });
});
