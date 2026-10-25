import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ReactNode } from "react";

import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CustomModelConnection,
  type CustomModelSaveInput,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { ModelConnectionEditor } from "./ModelConnectionEditor";
import { CUSTOM_MODEL_PRESETS } from "./customModels";

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

const pi = ProviderInstanceId.make("pi");
const droid = ProviderInstanceId.make("droid");
const connection: CustomModelConnection = {
  id: "shared",
  name: "Shared endpoint",
  baseUrl: "https://example.test/v1",
  protocol: "openai-completions",
  credentialId: "opaque-key-ref",
  models: [
    {
      id: "one",
      modelId: "one",
      name: "One",
      contextWindow: 32000,
      maxOutputTokens: 1024,
      reasoning: false,
      reasoningMetadata: {
        status: "known",
        source: "provider",
        checkedAt: "2026-09-06T00:00:00Z",
        stale: false,
        supported: true,
        levels: ["low", "medium", "high"],
        defaultLevel: "medium",
      },
      images: false,
      instanceIds: [pi],
    },
  ],
};
async function editor(
  _fixture: _Fixture,
  options: {
    connection?: CustomModelConnection;
    connections?: CustomModelConnection[];
    edit?: boolean;
    fail?: boolean;
    agents?: ReadonlyArray<{ id: ProviderInstanceId; name: string; driver?: ProviderDriverKind }>;
    defaultInstanceIds?: ReadonlyArray<ProviderInstanceId>;
  } = {},
) {
  const onSave = vi.fn(async (_input: CustomModelSaveInput) => {
    if (options.fail) throw new Error("Save failed");
  });
  const onClose = vi.fn();
  await mount(
    _fixture,
    <ModelConnectionEditor
      settings={{ revision: 7, connections: options.connections ?? [connection] }}
      target={{
        ...(options.connection ? { connection: options.connection } : {}),
        ...(options.edit ? { model: (options.connection ?? connection).models[0]! } : {}),
      }}
      agents={options.agents ?? [{ id: pi, name: "Pi" }]}
      defaultInstanceIds={options.defaultInstanceIds ?? [pi]}
      onSave={onSave}
      onClose={onClose}
    />,
  );
  const field = (label: string) => {
    const wrapper = [...document.querySelectorAll("label, div")]
      .reverse()
      .find(
        (element) =>
          [...element.children].some(
            (child) => child.tagName === "SPAN" && child.firstChild?.textContent === label,
          ) && element.querySelector("input,select"),
      );
    const input = wrapper?.querySelector<HTMLInputElement | HTMLSelectElement>("input,select");
    if (!input) throw new Error("Missing field " + label);
    return input;
  };
  const change = async (label: string, value: string) => {
    const target =
      label === "API key"
        ? document.querySelector<HTMLInputElement>('input[aria-label="API key"]')!
        : field(label);
    await userEvent.fill(target, value);
  };
  const choose = async (label: string, value: string) =>
    await userEvent.selectOptions(field(label) as HTMLSelectElement, value);
  const useExisting = async () =>
    await page.getByRole("button", { name: /Use existing (key|connection)/ }).click();
  const row = (label: string) => {
    const span = [...document.querySelectorAll("span")].find(
      (element) => element.textContent === label,
    );
    if (!span) throw new Error("Missing row " + label);
    return span.parentElement!.parentElement!.parentElement!;
  };
  const control = (label: string) =>
    document.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]')!;
  const optionLabels = new Map([
    ["", "Automatic"],
    ["automatic", "Automatic"],
    ["manual", "Set manually"],
    ["disabled", "Disabled"],
    ["enabled", "Enabled"],
    ["high", "High"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["max", "Max"],
    ["xhigh", "Extra-high"],
  ]);
  const optionLabel = (value: string) => optionLabels.get(value) ?? value;
  // Base UI's Select opens on the animation frame after the trigger's mousedown, so a
  // finished click does not mean an open menu. On a busy runner that frame came after the
  // next step: Escape went to a menu not yet open (which then opened and stayed open), or
  // the following click found it open and toggled it closed. Click once (a second click
  // would toggle a pending open closed) and wait for the open menu.
  const openMenu = async (label: string) => {
    await userEvent.click(control(label));
    await vi.waitFor(() => {
      expect(control(label).getAttribute("aria-expanded")).toBe("true");
      expect(
        [...document.querySelectorAll<HTMLElement>('[role="option"]')].some((o) =>
          o.checkVisibility(),
        ),
      ).toBe(true);
    });
  };
  const select = async (label: string, value: string) => {
    await openMenu(label);
    try {
      await page
        .getByRole("option", { name: optionLabel(value), exact: true })
        .click({ timeout: 10_000 });
    } catch (cause) {
      // Say what the menu looked like, so a CI-only failure is readable from the log.
      const menu = {
        expanded: control(label)?.getAttribute("aria-expanded"),
        options: [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent),
      };
      throw new Error(`Option "${optionLabel(value)}" never appeared: ${JSON.stringify(menu)}`, {
        cause,
      });
    }
  };
  const item = async (value: string) => {
    await openMenu("Reasoning");
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (element) =>
        element.textContent?.trim() === optionLabel(value) ||
        element.textContent?.trim() === optionLabel(value) + " (unavailable)",
    );
    const state = option
      ? { disabled: option.getAttribute("aria-disabled") === "true" }
      : undefined;
    await userEvent.keyboard("{Escape}");
    // Wait for the menu to finish closing (its options stay mounted, hidden): on a slow runner
    // the next click otherwise lands on the still-open menu and closes it instead.
    await vi.waitFor(() => {
      expect(control("Reasoning").getAttribute("aria-expanded")).toBe("false");
      expect(
        [...document.querySelectorAll<HTMLElement>('[role="option"]')].some((o) =>
          o.checkVisibility(),
        ),
      ).toBe(false);
    });
    return state;
  };
  const submit = async () => {
    await act(async () => {
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  };
  const advanced = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Advanced",
  );
  if (advanced?.getAttribute("aria-expanded") !== "true") await act(() => advanced?.click());
  return {
    field,
    change,
    choose,
    useExisting,
    row,
    control,
    select,
    submit,
    onSave,
    onClose,
    item,
  };
}

describe("custom model editor", () => {
  it("saves and clears a preference without overriding detected capabilities or changing limits", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture, { connection, edit: true });
    await f.select("Reasoning", "high");
    await f.submit();
    const saved = f.onSave.mock.calls[0]![0].connection.models[0]!;
    expect(saved.defaultReasoningLevel).toBe("high");
    expect(saved.reasoningOverride).toBeUndefined();
    expect(saved.reasoningMetadata).toBeUndefined();
    expect(saved.contextWindow).toBe(32000);
    expect(saved.maxOutputTokens).toBe(1024);
    expect(f.row("Reasoning").querySelector("p")?.textContent).toBe(
      "Detected: Low · Medium · High",
    );
    // Detected ladders offer no manual override; the levels are the provider's.
    expect(await f.item("manual")).toBeUndefined();
    await f.select("Reasoning", "");
    await f.submit();
    expect(f.onSave.mock.calls[1]![0].connection.models[0]!.defaultReasoningLevel).toBeUndefined();
  });
  // regression: e2fc205c51 feat(droid): custom models and setup say what will happen, and document it
  // Sole guard of the droidAttached gate on the Droid reasoning note.
  it("explains which reasoning levels Droid offers when the model is used with Droid", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const xhigh: CustomModelConnection = {
      ...connection,
      models: [
        {
          ...connection.models[0]!,
          instanceIds: [droid],
          reasoningMetadata: {
            ...connection.models[0]!.reasoningMetadata!,
            mode: "effort",
            levels: ["low", "medium", "high", "xhigh"],
          },
        },
      ],
    };
    const note =
      "Droid offers Low, Medium and High for this model, and Extra-high only as its default level.";
    const noteIn = (element: HTMLElement) => element.textContent!.includes(note);
    const withDroid = await editor(_fixture, {
      connection: xhigh,
      edit: true,
      agents: [{ id: droid, name: "Droid", driver: ProviderDriverKind.make("droid") }],
    });
    expect(noteIn(withDroid.row("Reasoning"))).toBe(true);

    await act(async () => await _fixture.root0!.unmount());
    _fixture.root0 = undefined;
    _fixture.host.remove();
    const piOnly = await editor(_fixture, {
      connection: { ...xhigh, models: [{ ...xhigh.models[0]!, instanceIds: [pi] }] },
      edit: true,
    });
    expect(noteIn(piOnly.row("Reasoning"))).toBe(false);
  });
  describe("default level of an Anthropic Messages model Droid does not know as adaptive", () => {
    const droidAgent = { id: droid, name: "Droid", driver: ProviderDriverKind.make("droid") };
    const piAgent = { id: pi, name: "Pi", driver: ProviderDriverKind.make("pi") };
    const plain = (instanceIds: ReadonlyArray<ProviderInstanceId>): CustomModelConnection => ({
      ...connection,
      protocol: "anthropic-messages",
      models: [
        {
          ...connection.models[0]!,
          modelId: "plain-anthropic",
          instanceIds,
          defaultReasoningLevel: "max",
          reasoningOverride: { supported: true, levels: ["low", "medium", "high", "max"] },
        },
      ],
    });
    const item = (f: Awaited<ReturnType<typeof editor>>, value: string) => f.item(value);
    const says = (f: Awaited<ReturnType<typeof editor>>, text: string) =>
      f.row("Reasoning").textContent!.includes(text);
    const substitute = "Droid cannot apply Max to this model and uses Medium instead.";

    it("offers a Droid-only model only the defaults Droid applies", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const f = await editor(_fixture, {
        connection: plain([droid]),
        edit: true,
        agents: [droidAgent, piAgent],
      });
      // The saved Max stays visible as what it is, and cannot be chosen again.
      expect((await item(f, "max"))?.disabled).toBe(true);
      for (const level of ["low", "medium", "high"])
        expect((await item(f, level))?.disabled).toBe(false);
      expect(says(f, substitute)).toBe(true);

      await f.select("Reasoning", "high");
      expect(await item(f, "max")).toBeUndefined();
      expect(says(f, substitute)).toBe(false);
      await f.submit();
      expect(f.onSave.mock.calls[0]![0].connection.models[0]!.defaultReasoningLevel).toBe("high");
    });

    it("keeps another agent's levels and says what Droid uses instead", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const f = await editor(_fixture, {
        connection: plain([droid, pi]),
        edit: true,
        agents: [droidAgent, piAgent],
      });
      // Pi applies Max, so it stays a choice.
      expect((await item(f, "max"))?.disabled).toBe(false);
      expect(says(f, substitute)).toBe(true);
    });

    it("says nothing about Droid when Droid is not attached", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const f = await editor(_fixture, {
        connection: plain([pi]),
        edit: true,
        agents: [droidAgent, piAgent],
      });
      expect((await item(f, "max"))?.disabled).toBe(false);
      expect(says(f, substitute)).toBe(false);
    });
  });
  it("preserves saved limits until the user switches them to automatic", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture, { connection, edit: true });
    expect(f.field("Context window").value).toBe(String(32000));
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models[0]).toMatchObject({
      contextWindow: 32000,
      maxOutputTokens: 1024,
    });
    await f.select("Limits", "automatic");
    expect(document.querySelector('input[type="number"]')).toBeNull();
    await f.submit();
    const automatic = f.onSave.mock.calls[1]![0].connection.models[0]!;
    expect(automatic.configurationMode).toBe("automatic");
    expect(automatic).not.toHaveProperty("contextWindow");
    expect(automatic).not.toHaveProperty("maxOutputTokens");
  });
  it("shows detected limits and starts manual editing from them", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { contextWindow: _c, maxOutputTokens: _m, ...saved } = connection.models[0]!;
    const automatic = {
      ...connection,
      models: [
        {
          ...saved,
          configurationMode: "automatic" as const,
          reasoningMetadata: {
            ...connection.models[0]!.reasoningMetadata!,
            contextWindow: 400_000,
            maxOutputTokens: 128_000,
            images: true,
          },
        },
      ],
    };
    const f = await editor(_fixture, {
      connection: automatic,
      connections: [automatic],
      edit: true,
    });
    expect(f.row("Limits").querySelector("p")?.textContent).toBe(
      "Detected: 400k context · 128k output",
    );
    expect(document.querySelector('input[type="number"]')).toBeNull();
    await f.select("Limits", "manual");
    expect(f.field("Context window").value).toBe(String(400_000));
    expect(f.field("Max output tokens").value).toBe(String(128_000));
    expect(f.row("Limits").querySelector("p")?.textContent).toBe(
      "Detected: 400k context · 128k output",
    );
  });
  it("does not invent limits for an unknown local endpoint", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture, { connection });
    await f.change("Model ID", "unknown");
    expect(f.field("Context window").value).toBe("");
    expect(f.field("Max output tokens").value).toBe("");
    await f.submit();
    expect(f.onSave).not.toHaveBeenCalled();
  });
  it("saves automatic images independently of manual limits and preserves explicit choices", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture, { connection, connections: [connection], edit: true });
    // This legacy model explicitly disabled images.
    expect(f.control("Image input").textContent).toContain("Disabled");
    await f.select("Image input", "automatic");
    await f.select("Limits", "automatic");
    await f.select("Limits", "manual");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models[0]).toMatchObject({
      configurationMode: "manual",
      imageInput: "automatic",
    });
  });
  it("defaults a new model's images to automatic", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture);
    await f.change("Model ID", "vision-new");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models.at(-1)!.imageInput).toBe("automatic");
  });
  it("defaults new models to automatic capability detection without inventing reasoning support", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture);
    expect(f.row("Limits").querySelector("p")?.textContent).toBe(
      "Detected from the provider after saving.",
    );
    expect(f.row("Reasoning").querySelector("p")?.textContent).toBe(
      "Detected from the provider after saving.",
    );
    await f.change("Model ID", "unknown-model");
    await f.submit();
    const model = f.onSave.mock.calls[0]![0].connection.models.at(-1)!;
    expect(model.reasoningOverride).toBeUndefined();
    expect(model.reasoningMetadata).toBeUndefined();
    expect(model.configurationMode).toBe("automatic");
    expect(model.contextWindow).toBeUndefined();
    expect(model.maxOutputTokens).toBeUndefined();
  });
  it("does not save an empty manual capability assertion", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture);
    await f.change("Model ID", "unknown-model");
    await f.select("Reasoning", "manual");
    await f.submit();
    expect(f.onSave).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Choose supported reasoning levels and a default from that list.",
    );
  });
  it("can return to automatic detection without retaining a manual override", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture);
    await f.change("Model ID", "unknown-model");
    await f.select("Reasoning", "manual");
    await f.select("Reasoning", "");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models.at(-1)?.reasoningOverride).toBeUndefined();
  });
  it("lets a manual reasoning ladder pick its default from the same selector", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture);
    await f.change("Model ID", "unknown-model");
    await f.select("Reasoning", "manual");
    await act(() => {
      const label = [...document.querySelectorAll("label")].find(
        (element) => element.textContent?.trim() === "Low",
      )!;
      label.querySelector<HTMLElement>('[role="checkbox"]')!.click();
    });
    await act(() => {
      const label = [...document.querySelectorAll("label")].find(
        (element) => element.textContent?.trim() === "High",
      )!;
      label.querySelector<HTMLElement>('[role="checkbox"]')!.click();
    });
    await f.select("Reasoning", "high");
    expect(f.control("Reasoning").textContent).toContain("High");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models.at(-1)).toMatchObject({
      reasoningOverride: { supported: true, levels: ["low", "high"] },
      defaultReasoningLevel: "high",
    });
  });
  // regression: 16d1e4d030 feat(models): add shared model connections for Pi and Droid (#246)
  // Sole guard of the default preset of a new connection.
  it("lists providers in the preferred order and defaults to OpenRouter", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(CUSTOM_MODEL_PRESETS.map((preset) => preset.id)).toEqual([
      "openrouter",
      "openai",
      "anthropic",
      "spacexai",
      "custom",
    ]);
    expect((await editor(_fixture)).field("Model provider").value).toBe("openrouter");
  });
  it("creates a redacted API-key submission attached to the default agents", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    // The panel passes the enabled agents (or the agent that opened the editor).
    const f = await editor(_fixture, {
      agents: [
        { id: droid, name: "Droid" },
        { id: pi, name: "Pi" },
      ],
      defaultInstanceIds: [droid],
    });
    await f.change("Model ID", "model-id");
    await f.change("API key", "synthetic-key");
    await f.submit();
    const saved = f.onSave.mock.calls[0]![0];
    expect(saved.revision).toBe(7);
    expect(Redacted.value(saved.apiKey!)).toBe("synthetic-key");
    expect(saved.connection.models[0]).toMatchObject({
      modelId: "model-id",
      name: "model-id",
      instanceIds: [droid],
    });
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it("shows an agent that was removed and lets the model be detached from it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const removed = ProviderInstanceId.make("droid_work");
    const stale: CustomModelConnection = {
      ...connection,
      models: [{ ...connection.models[0]!, instanceIds: [pi, removed] }],
    };
    const f = await editor(_fixture, { connection: stale, edit: true });
    const removedSwitch = () =>
      document.querySelector<HTMLElement>('[aria-label="Use with droid_work (removed)"]');
    expect(removedSwitch()?.getAttribute("aria-checked")).toBe("true");
    await act(() => removedSwitch()!.click());
    expect(removedSwitch()?.getAttribute("aria-checked")).toBe("false");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models[0]!.instanceIds).toEqual([pi]);
  });
  // regression: 9c85e2c8be fix(custom-models): keep provider test failures local
  it("preserves an existing model's explicit agent attachments", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture, {
      connection,
      edit: true,
      agents: [
        { id: droid, name: "Droid" },
        { id: pi, name: "Pi" },
      ],
    });
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models[0]!.instanceIds).toEqual([pi]);
  });
  it("adds a model to a saved connection without rewriting its key or other models", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture, { connection });
    await f.change("Model ID", "two");
    await f.change("Context window", "65536");
    await f.change("Max output tokens", "8192");
    await f.submit();
    const saved = f.onSave.mock.calls[0]![0];
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved.connection.id).toBe("shared");
    expect(saved.connection.models).toHaveLength(2);
    expect(saved.connection.models[0]).toEqual(connection.models[0]);
  });
  it("supports a keyless custom endpoint", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture);
    await f.choose("Model provider", "custom");
    await f.choose("API key", "");
    await f.change("Base URL", "http://localhost:8080/v1");
    await f.change("Model ID", "local-model");
    await f.change("Context window", "65536");
    await f.change("Max output tokens", "8192");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0]).not.toHaveProperty("apiKey");
    expect(f.onSave.mock.calls[0]![0].connection).toMatchObject({
      name: "localhost:8080",
      protocol: "openai-completions",
      baseUrl: "http://localhost:8080/v1",
    });
  });
  it("keeps an explicit connection name for a custom endpoint", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture);
    await f.choose("Model provider", "custom");
    await f.choose("API key", "");
    await f.change("Connection name", "Local");
    await f.change("Base URL", "http://localhost:8080/v1");
    await f.change("Model ID", "local-model");
    await f.change("Context window", "65536");
    await f.change("Max output tokens", "8192");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.name).toBe("Local");
  });
  it("reuses an existing connection by default and clears a draft key when switching", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture);
    await f.change("API key", "never-reuse");
    await f.choose("Model provider", "custom");
    expect(f.field("API key").value).toBe("shared");
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await f.choose("API key", "");
    expect(f.field("API key (optional)").value).toBe("");
  });
  it("offers only connections for the selected service and reuses their exact endpoint and key reference", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const openai = {
      ...connection,
      id: "openai-work",
      name: "Work",
      apiKeySuffix: "a7X9",
      baseUrl: "https://api.openai.com/v1",
    };
    const router = { ...connection, id: "router", baseUrl: "https://openrouter.ai/api/v1" };
    const f = await editor(_fixture, { connections: [openai, router, connection] });
    await f.choose("Model provider", "openai");
    expect(f.field("API key").querySelector('option[value="openai-work"]')).not.toBeNull();
    expect(f.field("API key").querySelector('option[value="router"]')).toBeNull();
    await f.choose("API key", "");
    await f.change("API key", "draft-must-not-be-sent");
    await f.useExisting();
    expect(f.field("API key").value).toBe("openai-work");
    expect(
      [...document.querySelectorAll("label")].some(
        (element) => element.querySelector("span")?.textContent === "Base URL",
      ),
    ).toBe(false);
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await f.change("Model ID", "new-model");
    await f.submit();
    const saved = f.onSave.mock.calls[0]![0];
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved).not.toHaveProperty("removeKey");
    expect(saved.connection).toMatchObject({
      id: openai.id,
      baseUrl: openai.baseUrl,
      protocol: openai.protocol,
    });
    expect(saved.connection.models).toHaveLength(2);
    expect(saved.connection.models[0]).toEqual(openai.models[0]);
  });
  it("clears reuse when switching services and retains the selected preset for new connections", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const router = { ...connection, id: "router", baseUrl: "https://openrouter.ai/api/v1" };
    const f = await editor(_fixture, { connections: [router, connection] });
    await f.choose("Model provider", "openrouter");
    expect(f.field("API key").value).toBe("router");
    await f.choose("API key", "");
    expect(f.field("Model provider").value).toBe("openrouter");
    expect(f.field("Base URL").value).toBe(router.baseUrl);
    await f.useExisting();
    await f.choose("Model provider", "anthropic");
    await f.change("API key", "new-anthropic-key");
    await f.change("Model ID", "new-model");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.id).not.toBe("router");
    expect(f.onSave.mock.calls[0]![0].connection.baseUrl).toBe("https://api.anthropic.com");
  });
  // regression: 16d1e4d030 feat(models): add shared model connections for Pi and Droid (#246)
  // Sole guard that choosing a preset applies its protocol.
  it("submits SpaceXAI with its preset endpoint and a redacted API key", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture);
    await f.choose("Model provider", "spacexai");
    await f.change("Model ID", "synthetic-grok-model");
    await f.change("API key", "synthetic-xai-key");
    await f.submit();
    const saved = f.onSave.mock.calls[0]![0];
    expect(saved.connection).toMatchObject({
      name: "SpaceXAI",
      baseUrl: "https://api.x.ai/v1",
      protocol: "openai-responses",
    });
    expect(Redacted.value(saved.apiKey!)).toBe("synthetic-xai-key");
  });
  it("edits only the selected model", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture, { connection, edit: true });
    await f.change("Display name", "Renamed");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models).toHaveLength(1);
    expect(f.onSave.mock.calls[0]![0].connection.models[0]).toMatchObject({
      id: "one",
      name: "Renamed",
    });
  });
  it("keeps the draft and dialog on failure", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const f = await editor(_fixture, { fail: true });
    await f.change("Model ID", "test");
    await f.submit();
    expect(f.onClose).not.toHaveBeenCalled();
    expect(f.field("Model ID").value).toBe("test");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Save failed");
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
