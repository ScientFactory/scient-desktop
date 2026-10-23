import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import type { ScientAnalyticsConsent } from "@t3tools/contracts";
import { type ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

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

async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
  mocks.consent = "off";
  mocks.deleteData.mockResolvedValue(undefined);
  mocks.setConsent.mockImplementation(async (_connection, consent) => ({
    available: true,
    consent,
  }));
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
async function render(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.rerender(<AnalyticsPrivacySettings />));
}
async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(() => element!.click());
}
function trigger(_fixture: _Fixture) {
  return _fixture.container.querySelector<HTMLElement>(
    '[aria-label="Share usage and reliability"]',
  );
}
async function details(_fixture: _Fixture) {
  await click(
    [..._fixture.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("What’s shared?"),
    ),
  );
}

describe("analytics sharing controls", () => {
  it("uses a compact, non-modal deletion confirmation and does nothing on cancel", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await click(
      [..._fixture.container.querySelectorAll("button")].find(
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await click(
      [..._fixture.container.querySelectorAll("button")].find(
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await click(
      [..._fixture.container.querySelectorAll("button")].find(
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    expect(_fixture.container.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(_fixture.container.querySelector('[role="combobox"]')).toBeNull();
    expect(trigger(_fixture)?.getAttribute("aria-checked")).toBe("false");
    expect(mocks.setConsent).not.toHaveBeenCalled();
    await click(trigger(_fixture));
    expect(mocks.setConsent).toHaveBeenLastCalledWith({}, "diagnostic");
    expect(trigger(_fixture)?.getAttribute("aria-checked")).toBe("true");
    await click(trigger(_fixture));
    expect(mocks.setConsent).toHaveBeenLastCalledWith({}, "off");
  });

  it.each(["essential", "product"] as const)(
    "preserves saved %s without increasing it",
    async (consent) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      mocks.consent = consent;
      await render(_fixture);
      expect(trigger(_fixture)?.getAttribute("aria-checked")).toBe("true");
      await details(_fixture);
      expect(document.body.textContent).toContain("It has not been increased.");
      expect(mocks.setConsent).not.toHaveBeenCalled();
    },
  );

  it("offers one clear explanation without requiring hover", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await details(_fixture);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(
      "Share which features and provider/model categories you use",
    );
    expect(dialog?.textContent).toContain("reported token counts");
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.setConsent.mockRejectedValueOnce(new Error("offline"));
    await render(_fixture);
    await click(trigger(_fixture));
    expect(trigger(_fixture)?.getAttribute("aria-checked")).toBe("false");
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("disables the switch during an in-flight save", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let resolve!: (status: { available: boolean; consent: ScientAnalyticsConsent }) => void;
    mocks.setConsent.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render(_fixture);
    await click(trigger(_fixture));
    expect(trigger(_fixture)?.hasAttribute("data-disabled")).toBe(true);
    await click(trigger(_fixture));
    expect(mocks.setConsent).toHaveBeenCalledTimes(1);
    await act(() => resolve({ available: true, consent: "diagnostic" }));
    expect(trigger(_fixture)?.hasAttribute("data-disabled")).toBe(false);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
