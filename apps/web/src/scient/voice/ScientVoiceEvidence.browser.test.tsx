vi.mock("./catalogDictation", () => ({
  useCatalogDictation: () => ({ enabled: true, setup: fixture.catalogConnected ? {} : null }),
}));

import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { SettingsScopeProvider } from "../../components/settings/SettingsScopeContext";
import "../../index.css";

const fixture = vi.hoisted(() => {
  const model = {
    id: "catalog/example-small",
    displayName: "Whisper Small",
    description: "Multilingual dictation",
    byteSize: 487_000_000,
    state: { state: "missing" },
  };
  const engine = {
    ...model,
    id: "handy-computer/parakeet-tdt-0.6b-v3-gguf",
    displayName: "Parakeet TDT 0.6B v3",
  };
  const languages =
    "bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt ro ru sk sl es sv uk".split(" ");
  const alternate = {
    ...engine,
    id: "handy-computer/whisper-large-v3-gguf",
    displayName: "Whisper Large v3",
  };
  return {
    commands: [] as unknown[],
    catalogConnected: true,
    removeLegacyModels: vi.fn<() => Promise<void>>(),
    languages,
    phase: "recording",
    environmentId: "local",
    legacy: {
      runtimeAvailable: true,
      selectedModelId: null,
      recommendation: null,
      activeDownloadModelId: null,
      models: [{ ...model, state: { state: "ready" } }],
    },
    catalog: {
      runtimeAvailable: true,
      selectedModelId: null,
      recommendation: { modelId: engine.id, language: "en" },
      models: [engine, alternate],
    },
  };
});

vi.mock("../../state/primaryEnvironment", async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { EnvironmentId } = await import("@t3tools/contracts");
  return {
    ...(await original<typeof import("../../state/primaryEnvironment")>()),
    localEnvironmentIdAtom: Atom.make(EnvironmentId.make(fixture.environmentId)),
  };
});
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironmentProviders: () =>
    new Map([
      [
        fixture.environmentId,
        [
          {
            instanceId: "fixture-codex",
            driver: "codex",
            enabled: true,
            displayName: "Codex (ChatGPT)",
            auth: { status: "authenticated", type: "chatgpt" },
          },
          {
            instanceId: "fixture-other-codex",
            driver: "codex",
            enabled: true,
            displayName: "Other Codex",
            auth: { status: "authenticated", type: "chatgpt" },
          },
        ],
      ],
    ]),
  usePrimaryEnvironmentId: () => fixture.environmentId,
}));
vi.mock("../../state/session", async (original) => {
  const Option = await import("effect/Option");
  const prepared = Option.some({ environmentId: fixture.environmentId });
  return {
    ...(await original<typeof import("../../state/session")>()),
    usePreparedConnection: () => prepared,
    useEnvironmentScope: () => true,
  };
});
vi.mock("@t3tools/client-runtime/voice-input", async (original) => {
  const Effect = await import("effect/Effect");
  return {
    ...(await original<typeof import("@t3tools/client-runtime/voice-input")>()),
    getEnvironmentSpeechStatus: () =>
      Effect.succeed({
        supported: true,
        benchmarkTier: "cpu",
        acceleration: "auto",
        modelUnloadTimeout: "never",
        gpuDevices: [],
      }),
    getEnvironmentSpeechModels: () =>
      Effect.succeed({
        models: [
          {
            id: "handy-computer/parakeet-tdt-0.6b-v3-gguf",
            name: "Parakeet TDT 0.6B v3",
            description: "Multilingual dictation",
            size: 739508576,
            languages: fixture.languages,
            accuracy: 3,
            speed: 5,
            benchmark: {
              accuracy: { en: { grade: "A-", errorPercent: 4 } },
              secondsPer30s: { accelerated: 2.2, cpu: 8 },
            },
            recommended: true,
            state: "installed",
            active: false,
            supportsStreaming: false,
            supportsLanguageDetection: true,
            supportsTranslation: false,
          },
          {
            id: "handy-computer/whisper-large-v3-gguf",
            name: "Whisper Large v3",
            description: "Recording transcription",
            size: 1_668_741_440,
            languages:
              "af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu haw ha he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo yue zh".split(
                " ",
              ),
            accuracy: 4,
            speed: 1,
            recommended: false,
            state: "downloadable",
            active: false,
            supportsLanguageDetection: true,
            supportsTranslation: true,
            supportsStreaming: false,
          },
          {
            id: "vladkens/ivrit-whisper-large-v3-turbo-gguf",
            name: "ivrit.ai Whisper Large V3 Turbo",
            description: "Hebrew recording transcription",
            size: 845_000_000,
            languages: ["he"],
            accuracy: 4,
            speed: 2,
            recommended: true,
            state: "downloadable",
            active: false,
            supportsLanguageDetection: false,
            supportsTranslation: false,
            supportsStreaming: false,
          },
          {
            id: "handy-computer/whisper-small-gguf",
            name: "Whisper Small",
            description: "Wide language support in a relatively small model.",
            size: 269_751_136,
            languages: ["en", "fr", "he"],
            accuracy: 3,
            speed: 2,
            recommended: false,
            state: "downloadable",
            active: false,
            supportsLanguageDetection: true,
            supportsTranslation: true,
            supportsStreaming: false,
          },
          {
            id: "handy-computer/canary-180m-flash-gguf",
            name: "Canary 180M Flash",
            description: "Compact multilingual model",
            size: 218_447_648,
            languages: ["de", "en", "es", "fr"],
            accuracy: 3,
            speed: 3,
            recommended: false,
            state: "downloadable",
            active: false,
            supportsLanguageDetection: false,
            supportsTranslation: true,
            supportsStreaming: false,
          },
        ],
      }),
  };
});
vi.mock("../../speech/runEnvironmentSpeech", async (original) => {
  const Effect = await import("effect/Effect");
  return {
    ...(await original<typeof import("../../speech/runEnvironmentSpeech")>()),
    runEnvironmentSpeech: Effect.runPromise,
  };
});
vi.mock("../../hooks/useSettings", async (original) => {
  const settings = await import("@t3tools/contracts");
  const environment = {
    ...settings.DEFAULT_SERVER_SETTINGS,
    customModels: {
      revision: 0,
      connections: [
        {
          id: "fixture-openai",
          name: "OpenAI connection",
          baseUrl: "https://api.openai.com/v1",
          credentialId: "opaque-fixture-id",
          apiKeySuffix: "OYkA",
          models: [],
          protocol: "openai-completions",
        },
      ],
    },
  };
  return {
    ...(await original<typeof import("../../hooks/useSettings")>()),
    useEnvironmentSettings: (
      _environmentId: string,
      select: (value: typeof environment) => unknown,
    ) => select(environment),
  };
});
vi.mock("../accounts/useAccounts", async (original) => ({
  ...(await original<typeof import("../accounts/useAccounts")>()),
  useAccounts: () => ({
    data: {
      accounts: [
        {
          accountId: "acc_fixture01",
          name: "Speech account",
          secrets: { token: { source: { type: "scient" }, hint: "OYkA" } },
          details: {
            kind: "api-key",
            speechOnly: true,
            auth: { type: "bearer" },
            sites: ["https://api.openai.com"],
          },
        },
      ],
    },
  }),
}));
vi.mock("../../state/use-atom-command", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtomCommand: (command: { label: string }) => async (request: unknown) => {
      fixture.commands.push(request);
      return AsyncResult.success(
        command.label.endsWith(":cloud-choices")
          ? [
              {
                id: "engine-1",
                model: "gpt-transcribe",
                origin: "https://api.openai.com",
                provider: "openai",
                keyLabel: "OpenAI connection",
                customModelConnectionId: "fixture-openai",
              },
              {
                id: "engine-2",
                model: "grok-voice-transcribe-2.0",
                origin: "https://api.x.ai",
                provider: "xai",
                keyLabel: "xAI",
                reconnect: true,
              },
            ]
          : command.label.endsWith(":saved-keys")
            ? [
                {
                  id: "fixture-openai",
                  kind: "custom-model",
                  label: "OpenAI connection",
                  hint: "OYkA",
                  origin: "https://api.openai.com",
                },
              ]
            : { words: [{ term: "Scient", source: "user", language: "und", variants: [] }] },
      );
    },
  };
});

vi.mock("./voiceClient", async (original) => ({
  ...(await original<typeof import("./voiceClient")>()),
  getVoiceBridge: () => ({
    hasLegacyModels: async () => true,
    removeLegacyModels: fixture.removeLegacyModels,
  }),
}));
vi.mock("./useScientVoiceController", async (original) => ({
  ...(await original<typeof import("./useScientVoiceController")>()),
  useScientVoiceController: () => ({
    phase: fixture.phase,
    levels: [0.03, 0.07, 0.2, 0.03, 0.1, 0.3, 0.05],
    elapsedMs: 22_000,
    errorMessage: null,
    microphonePermissionDenied: false,
    downloadPercent: 0,
    modelSnapshot: fixture.catalog,
    chatGptOffered: true,
    activate: vi.fn(),
    cancel: vi.fn(),
    stop: vi.fn(),
    chooseChatGpt: vi.fn(),
    setupModel: vi.fn(),
    dismissSetup: vi.fn(),
  }),
}));

import { ScientVoiceComposerControl } from "./ScientVoiceComposerControl";
import { ScientVoiceSettingsPanel } from "./ScientVoiceSettingsPanel";
import {
  __setClientSettingsForTests,
  getClientSettings,
  updateClientSettings,
} from "../../hooks/useSettings";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

const screenshots = import.meta.env.VITE_SCIENT_VOICE_SCREENSHOTS as string | undefined;

it.each(["light", "dark"])("shows dictation surfaces in %s", async (theme) => {
  const root = document.documentElement;
  const previous = root.classList.contains("dark");
  root.classList.toggle("dark", theme === "dark");
  try {
    await page.viewport(1000, 2300);
    const setting = (
      <main className="flex bg-background text-foreground" style={{ height: 2300 }}>
        <ScientVoiceSettingsPanel />
      </main>
    );
    await using screen = await render(setting);
    await expect.element(screen.getByRole("heading", { name: "Input" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Dictation" })).toBeVisible();
    await expect.element(screen.getByRole("switch", { name: "Clean up dictation" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Words" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Cloud engines" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Speech models" })).toBeVisible();
    await expect
      .element(screen.getByRole("switch", { name: "Agents may send audio to cloud engines" }))
      .toBeChecked();
    await expect.element(screen.getByText("Parakeet TDT 0.6B v3").last()).toBeVisible();
    await expect.element(screen.getByRole("combobox", { name: "Dictate with" })).toBeVisible();
    await expect
      .element(screen.getByRole("heading", { name: "Recordings", level: 2 }))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          "Dictation uses your chat’s connection when available. Otherwise uses Codex (ChatGPT).",
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("combobox", { name: "ChatGPT connection" }))
      .toHaveTextContent("Automatic");
    await expect.element(screen.getByRole("button", { name: "Choose a saved key…" })).toBeVisible();
    await expect.element(screen.getByText("25 languages")).not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Recommended for mixed languages", { exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Download Whisper Large v3" }))
      .toBeVisible();
    expect(screen.getByRole("button", { name: /^Open details for / }).all()).toHaveLength(4);
    await expect
      .element(screen.getByRole("button", { name: "Download Whisper Small" }))
      .toBeVisible();
    expect(screen.container.querySelector(".bg-warning")).toBeNull();
    if (screenshots) {
      await page.screenshot({ path: `${screenshots}/settings-${theme}.png` });
      await page.screenshot({
        path: `${screenshots}/engines-and-accounts-${theme}.png`,
        element: screen
          .getByRole("heading", { name: "Cloud engines" })
          .element()
          .closest("section")!,
      });
      await page.screenshot({
        path: `${screenshots}/recordings-defaults-${theme}.png`,
        element: screen
          .getByRole("heading", { name: "Recordings", level: 2 })
          .element()
          .closest("section")!,
      });
    }

    if (theme === "light") {
      const canary = screen.getByRole("button", { name: "Download Canary 180M Flash" });
      await expect.element(canary).not.toBeInTheDocument();
      await screen.getByRole("button", { name: /Show 1 more model/ }).click();
      await expect.element(canary).toBeVisible();
      await screen.getByRole("button", { name: "Show fewer models" }).click();
      await expect.element(canary).not.toBeInTheDocument();
    }

    const details = screen.getByRole("button", { name: "Details for Parakeet TDT 0.6B v3" });
    const cardBody = screen.getByRole("button", {
      name: "Open details for Parakeet TDT 0.6B v3",
    });
    if (theme === "light") {
      await details.hover();
    } else {
      cardBody.element().focus();
      await userEvent.keyboard("{Enter}");
    }
    const modelDetails = page.getByRole("dialog", { name: "Parakeet TDT 0.6B v3" });
    await expect.element(modelDetails.getByText("for dictation", { exact: true })).toBeVisible();
    await expect.element(modelDetails.getByText("25 languages")).toBeVisible();
    await expect.element(modelDetails.getByText("Multilingual dictation")).toBeVisible();
    await expect.element(modelDetails.getByText(/Speed:/)).toBeVisible();
    if (screenshots) {
      await expect.poll(() => getComputedStyle(modelDetails.element()).opacity).toBe("1");
      await page.screenshot({ path: `${screenshots}/speech-model-details-${theme}.png` });
    }
    await userEvent.keyboard("{Escape}");
    await expect.element(modelDetails).not.toBeInTheDocument();
    if (theme === "light") {
      await cardBody.click();
      await expect.element(modelDetails).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(modelDetails).not.toBeInTheDocument();
    }

    await screen.getByRole("button", { name: "Add a provider…" }).click();
    await expect.element(page.getByRole("dialog", { name: "Add a cloud engine" })).toBeVisible();
    await page.getByRole("combobox", { name: "Speech account" }).click();
    await page.getByRole("option", { name: /Use the key from OpenAI connection/ }).click();
    if (screenshots) {
      await page.screenshot({
        path: `${screenshots}/add-cloud-engine-${theme}.png`,
        element: page.getByRole("dialog", { name: "Add a cloud engine" }).element(),
      });
    }
    await page.getByRole("button", { name: "Add engine", exact: true }).click();
    expect(fixture.commands).toContainEqual({
      environmentId: "local",
      input: {
        action: "add",
        provider: "openai",
        model: "gpt-transcribe",
        customModelConnectionId: "fixture-openai",
      },
    });
    await screen.getByRole("button", { name: "Test gpt-transcribe with silent audio" }).click();
    await expect.element(screen.getByText("Connection works.")).toBeVisible();
    const composer = () => (
      <div
        className="flex items-end justify-center bg-background pb-16 text-foreground"
        style={{ height: 570 }}
      >
        <div className="rounded-2xl border border-border bg-card p-4" style={{ width: 620 }}>
          <p className="mb-8 text-sm">Draft a message</p>
          <div className="flex justify-end">
            <ScientVoiceComposerControl onTranscript={() => {}} onRequestSubmit={() => {}} />
          </div>
        </div>
      </div>
    );
    await page.viewport(860, 580);
    fixture.phase = "recording";
    await screen.rerender(composer());
    await expect
      .element(screen.getByRole("button", { name: "Transcribe and insert (Enter)" }))
      .toBeVisible();
    if (screenshots) await page.screenshot({ path: `${screenshots}/recording-${theme}.png` });

    fixture.phase = "setup-prompt";
    await screen.rerender(composer());
    await expect.element(page.getByText("Recommended for English")).toBeVisible();
    await expect
      .element(page.getByText("Whisper Large v3", { exact: true }))
      .not.toBeInTheDocument();
    if (screenshots) await page.screenshot({ path: `${screenshots}/first-run-${theme}.png` });
  } finally {
    root.classList.toggle("dark", previous);
  }
});

it("switches engines and cleanup without moving the settings below Dictation", async () => {
  const previous = getClientSettings();
  __setClientSettingsForTests({
    ...previous,
    voiceDictationEngine: "auto",
    voiceTranscriptCorrectionEnabled: false,
  });
  try {
    await page.viewport(1000, 1000);
    await using screen = await render(
      <SettingsScopeProvider search={{}} onChange={() => {}}>
        <ScientVoiceSettingsPanel />
      </SettingsScopeProvider>,
    );
    const engine = screen.getByRole("combobox", { name: "Dictate with" });
    const silence = screen.getByRole("switch", { name: "Silence filtering" });
    const cleanup = screen.getByRole("switch", { name: "Clean up dictation" });
    const model = screen.getByRole("heading", { name: "Cleanup model" });
    const recordings = screen.getByRole("heading", { name: "Recordings", exact: true });
    const recordingsTop = () => recordings.element().getBoundingClientRect().top + window.scrollY;
    await expect.element(engine).toHaveTextContent("Automatic");
    await expect.element(model).toBeVisible();
    await expect.element(silence).toBeEnabled();
    const top = recordingsTop();

    await engine.click();
    await page.getByRole("option", { name: "Off", exact: true }).click();
    await expect.element(engine).toHaveTextContent("Off");
    await expect.element(silence).toBeDisabled();
    expect(recordingsTop()).toBe(top);

    await engine.click();
    await page.getByRole("option", { name: /gpt-transcribe/ }).click();
    await expect.element(engine).toHaveTextContent("gpt-transcribe · api.openai.com");
    expect(getClientSettings().voiceCloudSelection).toEqual({
      environmentId: fixture.environmentId,
      engineId: "engine-1",
    });
    expect(recordingsTop()).toBe(top);

    await cleanup.click();
    await expect.element(cleanup).toBeChecked();
    await expect.element(model).toBeVisible();
    expect(recordingsTop()).toBe(top);
  } finally {
    await act(async () => {
      await updateClientSettings({
        voiceDictationEngine: previous.voiceDictationEngine,
        voiceCloudSelection: previous.voiceCloudSelection,
        voiceTranscriptCorrectionEnabled: previous.voiceTranscriptCorrectionEnabled,
      });
      __setClientSettingsForTests(previous);
    });
  }
});

it.each(["chatgpt", "cloud", "local"] as const)(
  "shows the %s composer mic without a ready local catalog",
  async (engine) => {
    const previous = getClientSettings();
    const previousPhase = fixture.phase;
    fixture.catalogConnected = false;
    fixture.phase = "idle";
    try {
      __setClientSettingsForTests({
        ...previous,
        voiceDictationEngine: engine,
        voiceChatGptInstanceId: ProviderInstanceId.make("fixture-codex"),
        voiceCloudSelection: { environmentId: EnvironmentId.make("local"), engineId: "engine-1" },
      });
      await using screen = await render(
        <ScientVoiceComposerControl
          environmentId={EnvironmentId.make("local")}
          onTranscript={() => {}}
        />,
      );
      await expect
        .element(screen.getByRole("button", { name: "Dictate a voice message" }))
        .toBeVisible();
    } finally {
      fixture.catalogConnected = true;
      fixture.phase = previousPhase;
      await act(() => __setClientSettingsForTests(previous));
    }
  },
);

it("offers to remove old models only after catalog dictation succeeds", async () => {
  const previous = getClientSettings();
  fixture.removeLegacyModels
    .mockReset()
    .mockRejectedValueOnce(new Error("Could not remove previous dictation model files."))
    .mockResolvedValueOnce(undefined);
  try {
    __setClientSettingsForTests({ ...previous, voiceCatalogDictated: false });
    {
      await using screen = await render(<ScientVoiceSettingsPanel />);
      expect(screen.container.textContent).not.toContain("Previous dictation models");
    }
    __setClientSettingsForTests({ ...previous, voiceCatalogDictated: true });
    await using screen = await render(<ScientVoiceSettingsPanel />);
    await expect.element(screen.getByText("Previous dictation models")).toBeVisible();
    const button = screen.getByRole("button", { name: "Remove old model files" });
    await button.click();
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await button.click();
    await expect.element(button).not.toBeInTheDocument();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    expect(fixture.removeLegacyModels).toHaveBeenCalledTimes(2);
  } finally {
    await act(() => __setClientSettingsForTests(previous));
  }
});

it("offers ready local, cloud and ChatGPT recording routes and keeps downloadable models out of the picker", async () => {
  await using screen = await render(<ScientVoiceSettingsPanel />);
  const section = screen
    .getByRole("heading", { name: "Recordings", exact: true, level: 2 })
    .element()
    .closest("section")!;
  await page.elementLocator(section).getByRole("combobox", { name: "Recording engine" }).click();
  // Downloads live in Speech models, not beside the default picker.
  expect([...section.querySelectorAll("button")].map((button) => button.textContent)).not.toContain(
    "Download",
  );
  for (const name of [
    "Parakeet TDT 0.6B v3",
    /gpt-transcribe.*api.openai.com/,
    /ChatGPT · Other Codex/,
  ]) {
    await expect.element(page.getByRole("option", { name })).toBeVisible();
  }
  expect(
    [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent),
  ).not.toContain("Whisper Large v3");
});

it("shares searchable language menus, with the search beside the trigger on either side", async () => {
  const previous = getClientSettings();
  __setClientSettingsForTests({ ...previous, voiceLanguagePreference: "auto" });
  try {
    await page.viewport(1000, 850);
    await using screen = await render(<ScientVoiceSettingsPanel />);
    const voice = screen.getByRole("button", { name: "Choose voice language" });
    const comparison = screen.getByRole("button", { name: "Compare languages" });
    const recording = screen.getByRole("button", { name: "Recording language" });
    const recommended = page.getByRole("button", { name: "Automatic Recommended" });
    const more = page.getByRole("button", { name: "More languages" });

    await voice.click();
    await expect.element(recommended).toBeVisible();
    const voicePopup = page.getByRole("dialog", { name: "Choose voice language" });
    const voiceSearch = voicePopup.getByRole("searchbox", { name: "Search languages" });
    await expect.element(voiceSearch).toHaveFocus();
    await expect.element(voicePopup).toHaveAttribute("data-side", "bottom");
    expect(voiceSearch.element().getBoundingClientRect().bottom).toBeLessThan(
      recommended.element().getBoundingClientRect().top,
    );
    expect(
      [...voicePopup.element().querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual(["AutomaticRecommended", "French", "English", "Hebrew", "Arabic", "More languages"]);
    if (screenshots) {
      await expect.poll(() => getComputedStyle(voicePopup.element()).opacity).toBe("1");
      await page.screenshot({ path: `${screenshots}/dictation-language-menu.png` });
    }
    await more.click();
    const list = more.element().parentElement!.parentElement!;
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    const searchTop = () => voiceSearch.element().getBoundingClientRect().top;
    const originalSearchTop = searchTop();
    list.scrollTop = list.scrollHeight;
    expect(searchTop()).toBe(originalSearchTop);
    await voiceSearch.fill("Tibetan");
    await expect.element(page.getByRole("button", { name: "Tibetan", exact: true })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.element(voice).toHaveTextContent("Tibetan");
    expect(getClientSettings().voiceLanguagePreference).toBe("bo");

    await comparison.element().scrollIntoView({ block: "end" });
    await comparison.click();
    const comparePopup = page.getByRole("dialog", { name: "Compare languages" });
    const compareSearch = comparePopup.getByRole("searchbox", { name: "Search languages" });
    await expect.element(compareSearch).toHaveFocus();
    await expect.element(comparePopup).toHaveAttribute("data-side", "top");
    const french = comparePopup.getByRole("button", { name: "French" });
    expect(compareSearch.element().getBoundingClientRect().top).toBeGreaterThan(
      french.element().getBoundingClientRect().bottom,
    );
    await expect.element(recommended).not.toBeInTheDocument();
    if (screenshots) {
      await expect.poll(() => getComputedStyle(comparePopup.element()).opacity).toBe("1");
      await page.screenshot({ path: `${screenshots}/compare-language-menu.png` });
    }
    await compareSearch.fill("zzzz");
    await expect.element(comparePopup.getByText("No languages found")).toBeVisible();
    await compareSearch.fill("Sinhala");
    await comparePopup.getByRole("button", { name: "Sinhala", exact: true }).click();

    await page.viewport(1000, 360);
    screen.container.querySelector<HTMLElement>("[data-settings-page-scroll]")!.style.maxWidth =
      "36rem";
    await comparison.element().scrollIntoView({ block: "center" });
    await comparison.click();
    await expect.element(compareSearch).toHaveFocus();
    if (screenshots) {
      await expect.poll(() => getComputedStyle(comparePopup.element()).opacity).toBe("1");
      await page.screenshot({ path: `${screenshots}/compare-short-window.png` });
    }
    await expect
      .poll(
        () => {
          const popup = comparePopup.element();
          const trigger = comparison.element().getBoundingClientRect();
          const menu = popup.getBoundingClientRect();
          const side = popup.getAttribute("data-side");
          if (side === "top") return Math.abs(trigger.top - menu.bottom - 4);
          if (side === "bottom") return Math.abs(menu.top - trigger.bottom - 4);
          return Infinity;
        },
        { timeout: 1500 },
      )
      .toBeLessThan(2);

    await compareSearch.fill("עברית");
    await page.getByRole("button", { name: "Hebrew", exact: true }).click();
    const hebrewCard = screen.getByRole("button", {
      name: "Open details for ivrit.ai Whisper Large V3 Turbo",
    });
    await expect.element(hebrewCard.getByText("Recommended for Hebrew")).toBeVisible();
    expect(screen.getByText("Recommended for Hebrew", { exact: true }).all()).toHaveLength(1);

    await comparison.click();
    await page.getByRole("button", { name: "Clear comparison" }).click();
    await expect.element(comparison).toHaveTextContent("Compare languages");

    await page.viewport(420, 850);
    await recording.click();
    const recordingPopup = page.getByRole("dialog", { name: "Recording language" });
    await expect
      .element(recordingPopup.getByRole("button", { name: "Automatic detection" }))
      .toBeVisible();
    await recordingPopup.getByRole("searchbox", { name: "Search languages" }).fill("Bashkir");
    await page.getByRole("button", { name: "Bashkir", exact: true }).click();
    await expect.element(recording).toHaveTextContent("Bashkir");
  } finally {
    await act(() => __setClientSettingsForTests(previous));
  }
});
