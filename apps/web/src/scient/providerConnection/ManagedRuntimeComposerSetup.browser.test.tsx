import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

import { PiIcon } from "../../components/Icons";
import { ManagedRuntimeComposerSetup } from "./ManagedRuntimeComposerSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const controller: ProviderLifecycleController = {
  planRuntime: vi.fn(),
  startRuntime: vi.fn(),
  cancelRuntime: vi.fn(),
  startConnection: vi.fn(),
  cancelConnection: vi.fn(),
  submitAuthorizationCode: vi.fn(),
  disconnect: vi.fn(),
  openAuthorizationPage: vi.fn(),
  updateExternalRuntime: vi.fn(),
};

function snapshot(models: boolean): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("pi"),
    driver: ProviderDriverKind.make("pi"),
    displayName: "Pi",
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: models ? "ready" : "warning",
    auth: { status: "unknown", required: false },
    checkedAt: "2026-09-27T00:00:00.000Z",
    models: models ? [{ slug: "a/model", name: "Model", isCustom: false, capabilities: null }] : [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: [],
      canDisconnect: false,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: ["repair", "remove"],
        managedVersion: "1.2.3",
        previousManagedVersion: null,
        operation: null,
        message: "Scient is using its private Pi runtime.",
      },
    },
  };
}

/** The provider onboarding popover body (ProviderOnboardingPicker). */
function OnboardingPopover(props: { readonly children: ReactNode }) {
  return (
    <div
      className="dropdown-glass model-picker-surface relative flex h-screen max-h-86.5 w-screen max-w-90 overflow-hidden rounded-lg"
      data-model-picker-content="true"
    >
      <aside className="w-11 shrink-0 bg-muted/30 p-1" />
      <section
        className="flex min-w-0 flex-1 flex-col border-l border-border/70 bg-muted/40"
        data-test-container="true"
      >
        {props.children}
      </section>
    </div>
  );
}

/** The model picker's setup overlay, a flex row (ModelPickerContent). */
function ModelPickerOverlay(props: { readonly children: ReactNode }) {
  return (
    <div
      className="relative flex h-screen max-h-86.5 w-screen max-w-90 flex-row overflow-hidden"
      data-model-picker-content="true"
    >
      <div className="w-11 shrink-0 bg-muted/30 p-1" />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-l border-border/70">
        <div className="relative min-h-0 flex-1 overflow-hidden pr-px">
          <div
            className="absolute inset-0 z-10 flex overflow-y-auto bg-muted/40"
            data-test-container="true"
          >
            {props.children}
          </div>
        </div>
      </div>
    </div>
  );
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

const CONTAINERS = [
  ["onboarding popover", OnboardingPopover],
  ["model picker overlay", ModelPickerOverlay],
] as const;
const STATES = [
  ["ready", true, "is ready"],
  ["no models", false, "Connect a model provider"],
] as const;

describe.each(CONTAINERS)("Pi in the %s", (_label, Container) => {
  it.each(STATES)(
    "renders the %s state as one centered frame with a visible action",
    async (_state, models, expectedTitle) => {
      // A desktop viewport, where the composer's popovers render at full size.
      await page.viewport(1280, 720);
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      root.render(
        <Container>
          <ManagedRuntimeComposerSetup
            controller={controller}
            displayName="Pi"
            environmentId={EnvironmentId.make("local")}
            icon={PiIcon}
            modelSetupHint="Add a custom model."
            provider={snapshot(models)}
          />
        </Container>,
      );
      await expect.poll(() => host!.querySelector("button")).toBeTruthy();

      const container = host.querySelector<HTMLElement>("[data-test-container=true]")!;
      const frames = container.querySelectorAll<HTMLElement>("[data-provider-onboarding-view]");
      expect(frames).toHaveLength(1);
      expect(container.children).toHaveLength(1);
      expect(container.textContent).toContain(expectedTitle);

      // The frame fills the container, so a flex-row overlay cannot squeeze it.
      const box = container.getBoundingClientRect();
      expect(Math.round(frames[0]!.getBoundingClientRect().width)).toBe(container.clientWidth);
      expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
      expect(container.scrollHeight).toBeLessThanOrEqual(container.clientHeight);

      const buttons = [...container.querySelectorAll("button")];
      expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Connect models"]);
      const button = buttons[0]!.getBoundingClientRect();
      expect(button.width).toBeGreaterThan(0);
      // Sized to its label like the reference actions, not a stretched bar.
      expect(button.width).toBeLessThan(box.width / 2);
      expect(button.left).toBeGreaterThanOrEqual(box.left);
      expect(button.right).toBeLessThanOrEqual(box.right);
      expect(button.top).toBeGreaterThanOrEqual(box.top);
      expect(button.bottom).toBeLessThanOrEqual(box.bottom);

      const center = (rect: DOMRect) => rect.left + rect.width / 2;
      const title = container.querySelector("[data-assisted-setup-title]")!;
      expect(Math.abs(center(button) - center(box))).toBeLessThan(2);
      expect(Math.abs(center(title.getBoundingClientRect()) - center(box))).toBeLessThan(2);
    },
  );
});
