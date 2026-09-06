// @vitest-environment happy-dom
import type { ScientAnalyticsConsent } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  consent: "off" as ScientAnalyticsConsent,
  setConsent: vi.fn(),
  record: vi.fn(),
  toast: vi.fn(),
  deleteData: vi.fn(),
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("../../state/session", () => ({ readPreparedConnection: () => ({}) }));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("./client", () => ({
  useRecordScientAnalytics: () => mocks.record,
  readScientAnalyticsStatus: async () => ({ available: true, consent: mocks.consent }),
  setScientAnalyticsConsent: mocks.setConsent,
  deleteScientAnalyticsData: mocks.deleteData,
}));
// Keep the real Switch, Popover and AlertDialog; only remove unrelated settings stores.
vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({
    title,
    description,
    status,
    control,
  }: {
    title: ReactNode;
    description: ReactNode;
    status?: ReactNode;
    control: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {status}
      {control}
    </div>
  ),
}));

import { AnalyticsPrivacySettings } from "./AnalyticsPrivacySettings";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.consent = "off";
  mocks.deleteData.mockResolvedValue(undefined);
  mocks.setConsent.mockImplementation(async (_connection, consent) => ({
    available: true,
    consent,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  await act(() => root.render(<AnalyticsPrivacySettings />));
}
async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(() => element!.click());
}
function trigger() {
  return container.querySelector<HTMLElement>('[aria-label="Share usage and reliability"]');
}
async function details() {
  await click(
    [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("What’s shared?"),
    ),
  );
}

describe("analytics sharing controls", () => {
  it("uses a compact, non-modal deletion confirmation and does nothing on cancel", async () => {
    await render();
    await click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Delete data",
      ),
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.classList.contains("max-w-sm")).toBe(true);
    expect(dialog?.getAttribute("aria-modal")).not.toBe("true");
    expect(document.querySelector('[data-slot="dialog-backdrop"]')).toBeNull();
    expect(dialog?.textContent).toContain("Delete analytics data?");
    expect(
      dialog?.querySelector('[data-slot="dialog-footer"]')?.classList.contains("border-t"),
    ).toBe(false);
    expect(mocks.deleteData).not.toHaveBeenCalled();
    await click(
      [...dialog!.querySelectorAll("button")].find((button) => button.textContent === "Cancel"),
    );
    expect(mocks.deleteData).not.toHaveBeenCalled();
  });

  it("requests deletion only after confirmation", async () => {
    await render();
    await click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Delete data",
      ),
    );
    const dialog = document.querySelector('[role="dialog"]');
    await click(
      [...dialog!.querySelectorAll("button")].find(
        (button) => button.textContent === "Delete data",
      ),
    );
    expect(mocks.deleteData).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Analytics deletion requested" }),
    );
  });

  it("cancels deletion when the user clicks outside", async () => {
    await render();
    await click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Delete data",
      ),
    );
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();

    const viewport = document.querySelector<HTMLElement>('[data-slot="dialog-viewport"]');
    expect(viewport).toBeTruthy();
    await act(async () => {
      viewport!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      viewport!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      viewport!.click();
      await Promise.resolve();
    });

    expect(document.querySelector('[role="dialog"][data-open]')).toBeNull();
    expect(mocks.deleteData).not.toHaveBeenCalled();
  });

  it("offers one switch and changes consent only when toggled", async () => {
    await render();
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(trigger()?.getAttribute("aria-checked")).toBe("false");
    expect(mocks.setConsent).not.toHaveBeenCalled();
    await click(trigger());
    expect(mocks.setConsent).toHaveBeenLastCalledWith({}, "diagnostic");
    expect(trigger()?.getAttribute("aria-checked")).toBe("true");
    await click(trigger());
    expect(mocks.setConsent).toHaveBeenLastCalledWith({}, "off");
  });

  it.each(["essential", "product"] as const)(
    "preserves saved %s without increasing it",
    async (consent) => {
      mocks.consent = consent;
      await render();
      expect(trigger()?.getAttribute("aria-checked")).toBe("true");
      await details();
      expect(document.body.textContent).toContain("It has not been increased.");
      expect(mocks.setConsent).not.toHaveBeenCalled();
    },
  );

  it("offers one clear explanation without requiring hover", async () => {
    await render();
    await details();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Share which features you use");
    expect(dialog?.querySelector("dl")).toBeNull();
    expect(dialog?.textContent).toContain(
      "Analytics never includes prompts, responses, file contents",
    );
    expect([...dialog!.querySelectorAll("strong")].map((heading) => heading.textContent)).toEqual([
      "Your privacy",
      "Storage",
      "Deleting data",
    ]);
    expect(dialog?.textContent).toContain("random installation identifier");
    expect(dialog?.textContent).toContain("30 days");
    expect(mocks.setConsent).not.toHaveBeenCalled();
  });

  it("restores the saved choice if a preference update fails", async () => {
    mocks.setConsent.mockRejectedValueOnce(new Error("offline"));
    await render();
    await click(trigger());
    expect(trigger()?.getAttribute("aria-checked")).toBe("false");
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("disables the switch during an in-flight save", async () => {
    let resolve!: (status: { available: boolean; consent: ScientAnalyticsConsent }) => void;
    mocks.setConsent.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    await click(trigger());
    expect(trigger()?.hasAttribute("data-disabled")).toBe(true);
    await click(trigger());
    expect(mocks.setConsent).toHaveBeenCalledTimes(1);
    await act(() => resolve({ available: true, consent: "diagnostic" }));
    expect(trigger()?.hasAttribute("data-disabled")).toBe(false);
  });
});
