import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderInstanceId,
  type CustomModelConnection,
  type CustomModelSaveInput,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useCallback: reactHookHarness.useCallback,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("~/state/server", () => ({ serverEnvironment: {} }));
vi.mock("~/state/environments", () => ({}));
vi.mock("~/state/session", () => ({}));
vi.mock("~/environments/primary", () => ({}));
vi.mock("~/state/use-atom-command", () => ({}));
vi.mock("./settingsLayout", () => ({}));

import { Select } from "../ui/select";
import { Choice, ModelConnectionEditor } from "./ModelConnectionEditor";
import { CUSTOM_MODEL_PRESETS, customModelPresetId } from "./customModels";
const pi = ProviderInstanceId.make("pi");
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
function find(
  node: unknown,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = find(child, predicate);
      if (match) return match;
    }
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (predicate(node)) return node;
  return find(node.props.children, predicate);
}
function editor(
  options: {
    connection?: CustomModelConnection;
    connections?: CustomModelConnection[];
    edit?: boolean;
    fail?: boolean;
  } = {},
) {
  const onSave = vi.fn(async (_input: CustomModelSaveInput) => {
    if (options.fail) throw new Error("Save failed");
  });
  const onClose = vi.fn();
  const render = () => {
    hooks.beginRender();
    return ModelConnectionEditor({
      settings: { revision: 7, connections: options.connections ?? [connection] },
      target: {
        ...(options.connection ? { connection: options.connection } : {}),
        ...(options.edit ? { model: (options.connection ?? connection).models[0]! } : {}),
      },
      agents: [{ id: pi, name: "Pi" }],
      defaultInstanceId: pi,
      onSave,
      onClose,
    });
  };
  const field = (label: string) => {
    const element = find(render(), (e) => e.props.label === label);
    if (!element || !isValidElement<Record<string, unknown>>(element.props.children))
      throw new Error("Missing field " + label);
    return element.props.children;
  };
  const change = (label: string, value: string) =>
    (
      field(label).props.onChange as (event: {
        target: { value: string; valueAsNumber: number };
      }) => void
    )({
      target: { value, valueAsNumber: Number(value) },
    });
  const choose = (label: string, value: string) =>
    (field(label).props.onChange as (value: string) => void)(value);
  const action = (label: string) => {
    const element = find(render(), (e) => e.props.label === label)?.props.action;
    if (!isValidElement<Record<string, unknown>>(element))
      throw new Error("Missing action for " + label);
    (element.props.onClick as () => void)();
  };
  const useExisting = () => action("API key");
  const row = (label: string) => {
    const element = find(render(), (e) => e.props.label === label && "control" in e.props);
    if (!element) throw new Error("Missing row " + label);
    return element;
  };
  const control = (label: string) => {
    const element = row(label).props.control;
    if (!isValidElement<Record<string, unknown>>(element))
      throw new Error("Missing control for " + label);
    return element;
  };
  const select = (label: string, value: string) =>
    (control(label).props.onValueChange as (value: string) => void)(value);
  const submit = async () => {
    const form = find(render(), (e) => e.type === "form")!;
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault() {},
    });
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    render,
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
  };
}
describe("custom model editor", () => {
  beforeEach(() => hooks.reset());
  it("saves and clears a preference without overriding detected capabilities or changing limits", async () => {
    const f = editor({ connection, edit: true });
    f.select("Reasoning", "high");
    await f.submit();
    const saved = f.onSave.mock.calls[0]![0].connection.models[0]!;
    expect(saved.defaultReasoningLevel).toBe("high");
    expect(saved.reasoningOverride).toBeUndefined();
    expect(saved.reasoningMetadata).toBeUndefined();
    expect(saved.contextWindow).toBe(32000);
    expect(saved.maxOutputTokens).toBe(1024);
    expect(f.row("Reasoning").props.description).toBe("Detected: Low · Medium · High");
    // Detected ladders offer no manual override; the levels are the provider's.
    expect(find(f.control("Reasoning"), (e) => e.props.value === "manual")).toBeUndefined();
    f.select("Reasoning", "");
    await f.submit();
    expect(f.onSave.mock.calls[1]![0].connection.models[0]!.defaultReasoningLevel).toBeUndefined();
  });
  it("preserves saved limits until the user switches them to automatic", async () => {
    const f = editor({ connection, edit: true });
    expect(f.field("Context window").props.value).toBe(32000);
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models[0]).toMatchObject({
      contextWindow: 32000,
      maxOutputTokens: 1024,
    });
    f.select("Limits", "automatic");
    expect(find(f.render(), (e) => e.props.label === "Context window")).toBeUndefined();
    await f.submit();
    const automatic = f.onSave.mock.calls[1]![0].connection.models[0]!;
    expect(automatic.configurationMode).toBe("automatic");
    expect(automatic).not.toHaveProperty("contextWindow");
    expect(automatic).not.toHaveProperty("maxOutputTokens");
  });
  it("shows detected limits and starts manual editing from them", () => {
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
    const f = editor({ connection: automatic, connections: [automatic], edit: true });
    expect(f.row("Limits").props.description).toBe("Detected: 400k context · 128k output");
    expect(find(f.render(), (e) => e.props.label === "Context window")).toBeUndefined();
    f.select("Limits", "manual");
    expect(f.field("Context window").props.value).toBe(400_000);
    expect(f.field("Max output tokens").props.value).toBe(128_000);
    expect(f.row("Limits").props.description).toBe("Detected: 400k context · 128k output");
  });
  it("does not invent limits for an unknown local endpoint", async () => {
    const f = editor({ connection });
    f.change("Model ID", "unknown");
    expect(f.field("Context window").props.value).toBe("");
    expect(f.field("Max output tokens").props.value).toBe("");
    await f.submit();
    expect(f.onSave).not.toHaveBeenCalled();
  });
  it("saves automatic images independently of manual limits and preserves explicit choices", async () => {
    const f = editor({ connection, connections: [connection], edit: true });
    // This legacy model explicitly disabled images.
    expect(f.control("Image input").props.value).toBe("disabled");
    f.select("Image input", "automatic");
    f.select("Limits", "automatic");
    f.select("Limits", "manual");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models[0]).toMatchObject({
      configurationMode: "manual",
      imageInput: "automatic",
    });
  });
  it("defaults a new model's images to automatic", async () => {
    const f = editor();
    f.change("Model ID", "vision-new");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models.at(-1)!.imageInput).toBe("automatic");
  });
  it("uses the shared compact selector for the limits and reasoning rows", () => {
    const f = editor();
    expect(f.field("Model provider").type).toBe(Choice);
    expect(f.control("Limits").type).toBe(Select);
    expect(f.control("Reasoning").type).toBe(Select);
  });
  it("defaults new models to automatic capability detection without inventing reasoning support", async () => {
    const f = editor();
    expect(f.row("Limits").props.description).toBe("Detected from the provider after saving.");
    expect(f.row("Reasoning").props.description).toBe("Detected from the provider after saving.");
    f.change("Model ID", "unknown-model");
    await f.submit();
    const model = f.onSave.mock.calls[0]![0].connection.models.at(-1)!;
    expect(model.reasoningOverride).toBeUndefined();
    expect(model.reasoningMetadata).toBeUndefined();
    expect(model.configurationMode).toBe("automatic");
    expect(model.contextWindow).toBeUndefined();
    expect(model.maxOutputTokens).toBeUndefined();
  });
  it("does not save an empty manual capability assertion", async () => {
    const f = editor();
    f.change("Model ID", "unknown-model");
    f.select("Reasoning", "manual");
    await f.submit();
    expect(f.onSave).not.toHaveBeenCalled();
    expect(find(f.render(), (e) => e.props.role === "alert")?.props.children).toBe(
      "Choose supported reasoning levels and a default from that list.",
    );
  });
  it("can return to automatic detection without retaining a manual override", async () => {
    const f = editor();
    f.change("Model ID", "unknown-model");
    f.select("Reasoning", "manual");
    f.select("Reasoning", "");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models.at(-1)?.reasoningOverride).toBeUndefined();
  });
  it("lets a manual reasoning ladder pick its default from the same selector", async () => {
    const f = editor();
    f.change("Model ID", "unknown-model");
    f.select("Reasoning", "manual");
    const level = (name: string) => {
      const children = find(
        f.render(),
        (e) => Array.isArray(e.props.children) && e.props.children[1] === name,
      )?.props.children;
      if (!Array.isArray(children)) throw new Error(`Missing reasoning level: ${name}`);
      return children[0] as ReactElement<Record<string, unknown>>;
    };
    (level("Low").props.onCheckedChange as (checked: boolean) => void)(true);
    (level("High").props.onCheckedChange as (checked: boolean) => void)(true);
    f.select("Reasoning", "high");
    expect(f.control("Reasoning").props.value).toBe("high");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models.at(-1)).toMatchObject({
      reasoningOverride: { supported: true, levels: ["low", "high"] },
      defaultReasoningLevel: "high",
    });
  });
  it("lists providers in the preferred order and defaults to OpenRouter", () => {
    expect(CUSTOM_MODEL_PRESETS.map((preset) => preset.id)).toEqual([
      "openrouter",
      "openai",
      "anthropic",
      "spacexai",
      "custom",
    ]);
    expect(editor().field("Model provider").props.value).toBe("openrouter");
  });
  it("creates a redacted API-key submission with an explicit Pi attachment", async () => {
    const f = editor();
    f.change("Model ID", "model-id");
    f.change("API key", "synthetic-key");
    await f.submit();
    const saved = f.onSave.mock.calls[0]![0];
    expect(saved.revision).toBe(7);
    expect(Redacted.value(saved.apiKey!)).toBe("synthetic-key");
    expect(saved.connection.models[0]).toMatchObject({
      modelId: "model-id",
      name: "model-id",
      instanceIds: [pi],
    });
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it("adds a model to a saved connection without rewriting its key or other models", async () => {
    const f = editor({ connection });
    f.change("Model ID", "two");
    f.change("Context window", "65536");
    f.change("Max output tokens", "8192");
    await f.submit();
    const saved = f.onSave.mock.calls[0]![0];
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved.connection.id).toBe("shared");
    expect(saved.connection.models).toHaveLength(2);
    expect(saved.connection.models[0]).toEqual(connection.models[0]);
  });
  it("supports a keyless custom endpoint", async () => {
    const f = editor();
    f.choose("Model provider", "custom");
    f.choose("API key", "");
    f.change("Base URL", "http://localhost:8080/v1");
    f.change("Model ID", "local-model");
    f.change("Context window", "65536");
    f.change("Max output tokens", "8192");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0]).not.toHaveProperty("apiKey");
    expect(f.onSave.mock.calls[0]![0].connection).toMatchObject({
      name: "localhost:8080",
      protocol: "openai-completions",
      baseUrl: "http://localhost:8080/v1",
    });
  });
  it("keeps an explicit connection name for a custom endpoint", async () => {
    const f = editor();
    f.choose("Model provider", "custom");
    f.choose("API key", "");
    f.change("Connection name", "Local");
    f.change("Base URL", "http://localhost:8080/v1");
    f.change("Model ID", "local-model");
    f.change("Context window", "65536");
    f.change("Max output tokens", "8192");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.name).toBe("Local");
  });
  it("reuses an existing connection by default and clears a draft key when switching", () => {
    const f = editor();
    f.change("API key", "never-reuse");
    f.choose("Model provider", "custom");
    expect(f.field("API key").props.value).toBe("shared");
    expect(find(f.render(), (e) => e.props.type === "password")).toBeUndefined();
    f.choose("API key", "");
    expect(f.field("API key (optional)").props.value).toBe("");
  });
  it("offers only connections for the selected service and reuses their exact endpoint and key reference", async () => {
    const openai = {
      ...connection,
      id: "openai-work",
      name: "Work",
      apiKeySuffix: "a7X9",
      baseUrl: "https://api.openai.com/v1",
    };
    const router = { ...connection, id: "router", baseUrl: "https://openrouter.ai/api/v1" };
    const f = editor({ connections: [openai, router, connection] });
    f.choose("Model provider", "openai");
    expect(
      find(f.field("API key"), (e) => e.type === "option" && e.props.value === "openai-work"),
    ).toBeDefined();
    expect(
      find(f.field("API key"), (e) => e.type === "option" && e.props.value === "router"),
    ).toBeUndefined();
    f.choose("API key", "");
    f.change("API key", "draft-must-not-be-sent");
    f.useExisting();
    expect(f.field("API key").props.value).toBe("openai-work");
    expect(find(f.render(), (e) => e.props.label === "Base URL")).toBeUndefined();
    expect(find(f.render(), (e) => e.props.type === "password")).toBeUndefined();
    f.change("Model ID", "new-model");
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
    const router = { ...connection, id: "router", baseUrl: "https://openrouter.ai/api/v1" };
    const f = editor({ connections: [router, connection] });
    f.choose("Model provider", "openrouter");
    expect(f.field("API key").props.value).toBe("router");
    f.choose("API key", "");
    expect(f.field("Model provider").props.value).toBe("openrouter");
    expect(f.field("Base URL").props.value).toBe(router.baseUrl);
    f.useExisting();
    f.choose("Model provider", "anthropic");
    f.change("API key", "new-anthropic-key");
    f.change("Model ID", "new-model");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.id).not.toBe("router");
    expect(f.onSave.mock.calls[0]![0].connection.baseUrl).toBe("https://api.anthropic.com");
  });
  it("classifies connections by exact endpoint and compatible protocol, never their display name", () => {
    expect(customModelPresetId({ ...connection, baseUrl: "https://api.x.ai/v1" })).toBe("spacexai");
    expect(customModelPresetId({ ...connection, name: "OpenAI" })).toBe("custom");
    expect(customModelPresetId({ ...connection, baseUrl: "https://api.openai.com/v1/" })).toBe(
      "openai",
    );
    expect(
      customModelPresetId({
        ...connection,
        baseUrl: "https://api.openai.com/v1",
        protocol: "anthropic-messages",
      }),
    ).toBe("custom");
    expect(
      customModelPresetId({ ...connection, baseUrl: "https://api.openai.com.attacker.test/v1" }),
    ).toBe("custom");
    expect(customModelPresetId({ ...connection, baseUrl: "https://api.openai.com/other" })).toBe(
      "custom",
    );
  });
  it("submits SpaceXAI with its preset endpoint and a redacted API key", async () => {
    const f = editor();
    f.choose("Model provider", "spacexai");
    f.change("Model ID", "synthetic-grok-model");
    f.change("API key", "synthetic-xai-key");
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
    const f = editor({ connection, edit: true });
    f.change("Display name", "Renamed");
    await f.submit();
    expect(f.onSave.mock.calls[0]![0].connection.models).toHaveLength(1);
    expect(f.onSave.mock.calls[0]![0].connection.models[0]).toMatchObject({
      id: "one",
      name: "Renamed",
    });
  });
  it("keeps the draft and dialog on failure", async () => {
    const f = editor({ fail: true });
    f.change("Model ID", "test");
    await f.submit();
    expect(f.onClose).not.toHaveBeenCalled();
    expect(f.field("Model ID").props.value).toBe("test");
    expect(find(f.render(), (e) => e.props.role === "alert")?.props.children).toBe("Save failed");
  });
});
