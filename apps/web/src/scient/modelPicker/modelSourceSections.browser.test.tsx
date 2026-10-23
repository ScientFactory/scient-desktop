import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";
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

async function renderPicker(
  _fixture: _Fixture,
  input: {
    readonly options: ReadonlyArray<ModelEsque>;
    readonly model: string;
    readonly onChange?: (instance: ProviderInstanceId, model: string) => void;
  },
) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(
    <ModelPickerContent
      environmentId={null}
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

const text = (_fixture: _Fixture) => _fixture.host?.textContent ?? "";
const header = (_fixture: _Fixture, label: string) =>
  [...(_fixture.host?.querySelectorAll<HTMLElement>("[aria-expanded]") ?? [])].find((element) =>
    element.textContent?.includes(label),
  );

async function _setupFixture0(_fixture: _Fixture) {
  window.localStorage.removeItem(COLLAPSED_MODEL_SOURCES_STORAGE_KEY);
  await page.viewport(1280, 900);
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
  window.localStorage.removeItem(COLLAPSED_MODEL_SOURCES_STORAGE_KEY);
}

describe("Oh My Pi model picker sections", () => {
  it("shows both sections, collapses one, remembers it, and lets search reach it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await renderPicker(_fixture, { options: ACCOUNT_AND_CUSTOM, model: "scient_local/qwen" });
    await expect.poll(() => header(_fixture, "Your Oh My Pi accounts")).toBeTruthy();
    expect(header(_fixture, "Scient custom models")).toBeTruthy();
    for (const name of ["Claude Opus", "Claude Sonnet", "GPT Sol", "GLM Flash", "Qwen Local"]) {
      expect(text(_fixture)).toContain(name);
    }
    // Account models are grouped by provider: both Anthropic models come first.
    expect(text(_fixture).indexOf("Claude Sonnet")).toBeLessThan(text(_fixture).indexOf("GPT Sol"));
    expect(header(_fixture, "Your Oh My Pi accounts")?.getAttribute("aria-expanded")).toBe("true");

    header(_fixture, "Your Oh My Pi accounts")!.click();
    await expect.poll(() => text(_fixture).includes("Claude Opus")).toBe(false);
    expect(text(_fixture)).toContain("Qwen Local");
    expect(header(_fixture, "Your Oh My Pi accounts")?.getAttribute("aria-expanded")).toBe("false");
    expect(header(_fixture, "Your Oh My Pi accounts")?.textContent).toContain("3 models");
    expect(window.localStorage.getItem(COLLAPSED_MODEL_SOURCES_STORAGE_KEY)).toContain(
      "model-source:accounts:omp",
    );

    // A fresh picker keeps the section collapsed.
    await renderPicker(_fixture, { options: ACCOUNT_AND_CUSTOM, model: "scient_local/qwen" });
    await expect.poll(() => header(_fixture, "Your Oh My Pi accounts")).toBeTruthy();
    expect(text(_fixture)).not.toContain("Claude Opus");

    // Search lists plain matches, including collapsed ones, without headers.
    await userEvent.type(_fixture.host!.querySelector("input")!, "sonnet");
    await expect.poll(() => text(_fixture).includes("Claude Sonnet")).toBe(true);
    expect(header(_fixture, "Your Oh My Pi accounts")).toBeUndefined();

    await userEvent.clear(_fixture.host!.querySelector("input")!);
    await expect.poll(() => header(_fixture, "Your Oh My Pi accounts")).toBeTruthy();
    header(_fixture, "Your Oh My Pi accounts")!.click();
    await expect.poll(() => text(_fixture).includes("Claude Opus")).toBe(true);
    expect(window.localStorage.getItem(COLLAPSED_MODEL_SOURCES_STORAGE_KEY)).not.toContain(
      "model-source:accounts:omp",
    );
  });

  it("opens the section holding the selected model, then collapses it on request", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    window.localStorage.setItem(
      COLLAPSED_MODEL_SOURCES_STORAGE_KEY,
      JSON.stringify(["model-source:custom:omp"]),
    );
    await renderPicker(_fixture, { options: ACCOUNT_AND_CUSTOM, model: "scient_openrouter/glm" });
    await expect.poll(() => header(_fixture, "Scient custom models")).toBeTruthy();
    expect(text(_fixture)).toContain("GLM Flash");
    expect(header(_fixture, "Scient custom models")?.getAttribute("aria-expanded")).toBe("true");

    header(_fixture, "Scient custom models")!.click();
    await expect.poll(() => text(_fixture).includes("GLM Flash")).toBe(false);
    expect(header(_fixture, "Scient custom models")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("selects a model from a section and never selects a header", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onChange = vi.fn();
    await renderPicker(_fixture, {
      options: ACCOUNT_AND_CUSTOM,
      model: "anthropic/opus",
      onChange,
    });
    await expect.poll(() => header(_fixture, "Scient custom models")).toBeTruthy();
    header(_fixture, "Scient custom models")!.click();
    header(_fixture, "Scient custom models")!.click();
    expect(onChange).not.toHaveBeenCalled();

    const row = [..._fixture.host!.querySelectorAll<HTMLElement>("[role=option]")].find(
      (element) =>
        element.textContent?.includes("GLM Flash") && !element.hasAttribute("aria-expanded"),
    );
    row!.click();
    await expect.poll(() => onChange.mock.calls.length).toBe(1);
    expect(onChange).toHaveBeenCalledWith(instanceId, "scient_openrouter/glm");
  });

  it("toggles a highlighted header with Enter", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await renderPicker(_fixture, { options: ACCOUNT_AND_CUSTOM, model: "anthropic/opus" });
    await expect.poll(() => header(_fixture, "Your Oh My Pi accounts")).toBeTruthy();
    const input = _fixture.host!.querySelector("input")!;
    input.focus();
    // The first row is the accounts header.
    await userEvent.keyboard("{Home}");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => text(_fixture).includes("Claude Opus")).toBe(false);
  });

  it("shows a plain list when an instance has only one kind of model", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await renderPicker(_fixture, {
      options: ACCOUNT_AND_CUSTOM.slice(0, 3),
      model: "anthropic/opus",
    });
    await expect.poll(() => text(_fixture).includes("Claude Opus")).toBe(true);
    expect(header(_fixture, "Your Oh My Pi accounts")).toBeUndefined();
    expect(header(_fixture, "Scient custom models")).toBeUndefined();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
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
