import { createMemoryHistory } from "@tanstack/react-router";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/index.css";
// The route loads ChatView lazily; importing it here keeps its first transform out of the timeout.
import "~/components/ChatView";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import type * as ControlsMeasurement from "~/components/chat/restingComposerControlsMeasurement";
import type * as FooterLayout from "~/components/composerFooterLayout";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { getRouter } from "~/router";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { measureModelNameFit } from "./modelNameFit";

type Layout = ReturnType<typeof FooterLayout.resolveRestingComposerControlsLayout>;
type LayoutInput = Parameters<typeof FooterLayout.resolveRestingComposerControlsLayout>[0];

// Every footer layout the composer resolves, so a check waits for the measurement of its width.
const footer = vi.hoisted(() => ({
  layouts: [] as Array<{ input: LayoutInput; result: Layout }>,
  controls: null as HTMLElement | null,
  resolve: null as typeof FooterLayout.resolveRestingComposerControlsLayout | null,
  measure: null as typeof ControlsMeasurement.measureRestingComposerControls | null,
}));

vi.mock(import("~/components/composerFooterLayout"), async (original) => {
  const actual = await original();
  footer.resolve = actual.resolveRestingComposerControlsLayout;
  return {
    ...actual,
    resolveRestingComposerControlsLayout: (input) => {
      const result = actual.resolveRestingComposerControlsLayout(input);
      footer.layouts.push({ input, result });
      return result;
    },
  };
});

vi.mock(import("~/components/chat/restingComposerControlsMeasurement"), async (original) => {
  const actual = await original();
  footer.measure = actual.measureRestingComposerControls;
  return {
    ...actual,
    measureRestingComposerControls: (controls) => {
      if (controls.querySelector("[data-chat-provider-model-picker]")) footer.controls = controls;
      return actual.measureRestingComposerControls(controls);
    },
  };
});

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

function modelTrigger(root: ParentNode) {
  const trigger = root.querySelector<HTMLElement>("[data-chat-provider-model-picker]")!;
  const label = trigger.querySelector<HTMLElement>("[data-chat-provider-model-picker-label]")!;
  const icon = trigger.querySelector<HTMLElement>("[data-chat-provider-model-picker-icon] > *");
  return {
    trigger,
    name: trigger.getAttribute("aria-label") ?? "",
    nameShown: getComputedStyle(label).visibility !== "hidden",
    iconShown:
      icon !== null &&
      icon.getBoundingClientRect().width > 0 &&
      getComputedStyle(icon).visibility !== "hidden",
    shownWidth: label.clientWidth,
    fullWidth: label.scrollWidth,
  };
}

/** Shown, the name keeps at least a few letters; hidden, the provider icon stands in for it. */
function expectReadable(trigger: ReturnType<typeof modelTrigger>) {
  if (trigger.nameShown) {
    expect(trigger.shownWidth).toBeGreaterThanOrEqual(Math.min(trigger.fullWidth, 40));
  } else {
    expect(trigger.iconShown).toBe(true);
  }
}

/**
 * Waits for the footer to measure the current width and for nothing to be left to measure, then
 * returns whether the name was hidden at each layout since the resize; more than one change flaps.
 */
async function settleFooter(resize: () => void): Promise<boolean[]> {
  const start = footer.layouts.length;
  resize();
  await vi.waitFor(() => {
    const latest = footer.layouts.at(-1);
    expect(footer.layouts.length).toBeGreaterThan(start);
    expect(modelTrigger(footer.controls!).trigger.dataset.modelNameHidden === "true").toBe(
      latest!.result.modelNameHidden === true,
    );
    const measurement = footer.measure!(footer.controls!)!;
    expect(
      footer.resolve!({
        ...measurement,
        hostWidth: latest!.input.hostWidth,
        previous: latest!.result,
      }),
    ).toEqual(latest!.result);
  });
  return footer.layouts.slice(start).map(({ result }) => result.modelNameHidden === true);
}

function transitions(states: readonly boolean[]) {
  return states.filter((state, index) => index > 0 && state !== states[index - 1]).length;
}

const NARROWEST = 120;
const COMPOSER_MODELS = [
  { slug: "claude-opus-4-6", name: "Claude Opus 4.6", providerCostLabel: "2×" },
  // A one-letter alias fits inside the text trigger's minimum width, which the icon-only one drops.
  { slug: "claude-i", name: "I" },
] as const;

/** Renders a thread whose composer uses the given Claude model, with its width under the test's control. */
async function withComposer(
  model: (typeof COMPOSER_MODELS)[number],
  run: (composer: {
    form: HTMLElement;
    composerWidth: (width: number) => () => void;
  }) => Promise<void>,
) {
  await page.viewport(1200, 800);
  // One catalog for every case and a thread per model, since app stores outlive one render.
  const claude = {
    ...CLAUDE_PROVIDER,
    models: COMPOSER_MODELS.map((entry) => ({ ...CLAUDE_PROVIDER.models[0]!, ...entry })),
  };
  const thread = {
    ...threadWithHistory(`thread-narrow-${model.slug}`, 1),
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: model.slug },
  };
  using _environment = installFakeEnvironment([thread], { providers: [CODEX_PROVIDER, claude] });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  const form = document.querySelector<HTMLElement>('[data-chat-composer-form="true"]')!;
  await vi.waitFor(() => expect(modelTrigger(form).name.startsWith(model.name)).toBe(true));
  await run({
    form,
    composerWidth: (width) => () => {
      form.style.setProperty("width", `${width}px`, "important");
      form.style.setProperty("max-width", `${width}px`, "important");
    },
  });
}

/** Narrows a step at a time; the name reads at every width until it gives way to the icon for good. */
async function narrowUntilIconOnly(
  form: HTMLElement,
  composerWidth: (width: number) => () => void,
  narrowest: number,
) {
  await settleFooter(composerWidth(620));
  expect(modelTrigger(form).nameShown).toBe(true);
  let truncatedReadable = false;
  let collapsedAt: number | null = null;
  for (let width = 600; width >= narrowest; width -= 10) {
    expect(transitions(await settleFooter(composerWidth(width)))).toBeLessThanOrEqual(1);
    const trigger = modelTrigger(form);
    expectReadable(trigger);
    if (trigger.nameShown && trigger.shownWidth < trigger.fullWidth) truncatedReadable = true;
    if (!trigger.nameShown) collapsedAt ??= width;
    if (collapsedAt !== null) expect(trigger.nameShown).toBe(false);
  }
  expect(collapsedAt).not.toBeNull();
  return { collapsedAt: collapsedAt!, truncatedReadable };
}

/** The exact threshold holds still, whichever side the composer comes from. */
async function expectStableThreshold(
  form: HTMLElement,
  composerWidth: (width: number) => () => void,
  collapsedAt: number,
  narrowest: number,
) {
  let threshold = collapsedAt;
  await settleFooter(composerWidth(620));
  for (let width = collapsedAt + 9; width > collapsedAt; width -= 1) {
    await settleFooter(composerWidth(width));
    if (!modelTrigger(form).nameShown) {
      threshold = width;
      break;
    }
  }
  for (const width of [threshold, threshold + 1]) {
    for (const from of [620, narrowest]) {
      await settleFooter(composerWidth(from));
      expect(transitions(await settleFooter(composerWidth(width)))).toBeLessThanOrEqual(1);
      const settled = modelTrigger(form);
      expectReadable(settled);
      const remeasured = await settleFooter(() =>
        document.fonts.dispatchEvent(new Event("loadingdone")),
      );
      expect(remeasured.every((hidden) => hidden === !settled.nameShown)).toBe(true);
    }
  }
}

it("a composer too narrow for a readable model name shows the provider icon, never a fragment", async () => {
  await withComposer(COMPOSER_MODELS[0], async ({ form, composerWidth }) => {
    const { collapsedAt, truncatedReadable } = await narrowUntilIconOnly(
      form,
      composerWidth,
      NARROWEST,
    );
    expect(truncatedReadable).toBe(true);

    // Icon-only, the trigger still names the model and its cost, and opens from the keyboard.
    const collapsed = modelTrigger(form);
    expect(collapsed.name).toMatch(/^Claude Opus 4\.6, Costs 2× of the provider's base token rate/);
    collapsed.trigger.focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByPlaceholder("Search models...")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByPlaceholder("Search models...")).not.toBeInTheDocument();
    modelTrigger(form).trigger.focus();
    await userEvent.keyboard(" ");
    await expect.element(page.getByPlaceholder("Search models...")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByPlaceholder("Search models...")).not.toBeInTheDocument();

    await expectStableThreshold(form, composerWidth, collapsedAt, NARROWEST);

    await settleFooter(composerWidth(620));
    const wide = modelTrigger(form);
    expect(wide.nameShown).toBe(true);
    expect(wide.shownWidth).toBe(wide.fullWidth);
    expect(wide.name).not.toContain("Costs");
  });
});

it("a short model name gives way to the icon once and holds still", async () => {
  await withComposer(COMPOSER_MODELS[1], async ({ form, composerWidth }) => {
    const { collapsedAt } = await narrowUntilIconOnly(form, composerWidth, NARROWEST);
    await expectStableThreshold(form, composerWidth, collapsedAt, NARROWEST);
  });
});

const instanceId = ProviderInstanceId.make("claudeAgent");
const entries = deriveProviderInstanceEntries([
  {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-20T00:00:00.000Z",
    models: [
      { slug: "claude-opus-4-6", name: "Claude Opus 4.6", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  },
]);

function renderPicker(
  props: Partial<Parameters<typeof ProviderModelPicker>[0]> & { isUnavailable?: boolean },
) {
  const { isUnavailable, ...pickerProps } = props;
  return render(
    <div className="flex w-40">
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model="claude-opus-4-6"
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={
          new Map([
            [
              instanceId,
              [
                {
                  slug: "claude-opus-4-6",
                  name: "Claude Opus 4.6",
                  isCustom: false,
                  ...(isUnavailable ? { isUnavailable } : {}),
                },
              ],
            ],
          ])
        }
        onInstanceModelChange={() => {}}
        {...pickerProps}
      />
    </div>,
  );
}

it("keeps a provider update's status readable instead of leaving only the icon", async () => {
  await using screen = await renderPicker({
    statusLabel: "Updating Claude…",
    triggerAriaLabel: "Claude update in progress",
    modelNameHidden: true,
  });
  await expect.element(screen.getByText("Updating Claude…")).toBeVisible();
  const trigger = modelTrigger(screen.container);
  expect(trigger.nameShown).toBe(true);
  expect(measureModelNameFit(trigger.trigger).truncatableWidth).toBeUndefined();
});

it("keeps the Unavailable badge when the model name gives way to the icon", async () => {
  await using screen = await renderPicker({ isUnavailable: true, modelNameHidden: true });
  await expect.element(screen.getByText("Unavailable", { exact: true })).toBeVisible();
  const trigger = modelTrigger(screen.container);
  expect(trigger.nameShown).toBe(false);
  expect(trigger.iconShown).toBe(true);
});

it("keeps the model names of selections whose providers left the catalog", async () => {
  const missing = ProviderInstanceId.make("removed");
  await using screen = await renderPicker({
    selectedModels: [
      { instanceId: missing, model: "model-a" },
      { instanceId: ProviderInstanceId.make("removed-too"), model: "model-b" },
    ],
  });
  await expect.element(screen.getByText("model-a, model-b")).toBeVisible();
  expect(measureModelNameFit(modelTrigger(screen.container).trigger).truncatableWidth).toBe(
    undefined,
  );
  await screen.rerender(
    <div className="flex w-40">
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model="claude-opus-4-6"
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={new Map()}
        selectedModels={[
          { instanceId: missing, model: "model-a" },
          { instanceId, model: "claude-opus-4-6" },
        ]}
        onInstanceModelChange={() => {}}
      />
    </div>,
  );
  await expect
    .poll(() => measureModelNameFit(modelTrigger(screen.container).trigger).truncatableWidth)
    .toBeTypeOf("number");
});

it("keeps the Unavailable badge of a multi-model draft whose names give way to the icons", async () => {
  const multiPicker = (modelNameHidden: boolean) => (
    <div className="flex w-160">
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model="claude-opus-4-6"
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={
          new Map([
            [
              instanceId,
              [
                { slug: "claude-opus-4-6", name: "Claude Opus 4.6", isCustom: false },
                {
                  slug: "claude-opus-4-5",
                  name: "Claude Opus 4.5",
                  isCustom: false,
                  isUnavailable: true,
                },
              ],
            ],
          ])
        }
        selectedModels={[
          { instanceId, model: "claude-opus-4-6" },
          { instanceId, model: "claude-opus-4-5" },
        ]}
        modelNameHidden={modelNameHidden}
        // Untruncated, the text trigger's width is the one its icon-only form reconstructs.
        triggerClassName="max-w-none sm:max-w-none"
        onInstanceModelChange={() => {}}
      />
    </div>
  );
  await using screen = await render(multiPicker(false));
  await expect.element(screen.getByText(/\(Unavailable\)/)).toBeVisible();
  const textWidth = modelTrigger(screen.container).trigger.getBoundingClientRect().width;

  await screen.rerender(multiPicker(true));
  await expect.element(screen.getByText("Unavailable", { exact: true })).toBeVisible();
  const iconOnly = modelTrigger(screen.container);
  expect(iconOnly.nameShown).toBe(false);
  expect(iconOnly.iconShown).toBe(true);
  // The badge shows only icon-only, so the reconstructed text trigger leaves it out.
  expect(
    iconOnly.trigger.getBoundingClientRect().width +
      measureModelNameFit(iconOnly.trigger).hiddenWidth,
  ).toBeCloseTo(textWidth, 0);
});
