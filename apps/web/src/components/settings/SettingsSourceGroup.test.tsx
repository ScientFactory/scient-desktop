// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  SettingsSourceGroup,
  SettingsSourcePanel,
  SettingsSourceStrip,
  SettingsSourceStripItem,
} from "./SettingsSourceStrip";

describe("shared raised settings surface", () => {
  let root: Root;
  let host: HTMLDivElement;
  let observerCallback: () => void;
  let labelLeft: number;
  let panelHeight: number;
  const disconnect = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    labelLeft = 20;
    panelHeight = 200;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observerCallback = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const panel = this.hasAttribute("data-source-panel");
      const trigger = this.tagName === "BUTTON";
      return DOMRect.fromRect({
        x: trigger ? labelLeft : 0,
        y: panel ? 80 : 0,
        width: trigger ? 100 : 600,
        height: panel ? panelHeight : 60,
      });
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    disconnect.mockClear();
  });
  const render = async (id: string | null = 'panel:with"special-id') => {
    await act(() =>
      root.render(
        <SettingsSourceGroup activePanelId={id}>
          <SettingsSourceStrip label="Sources">
            <SettingsSourceStripItem
              controls={'panel:with"special-id'}
              expanded={id !== null}
              label="Python"
              icon={<span />}
              separated={false}
              onToggle={() => {}}
            />
          </SettingsSourceStrip>
          <SettingsSourcePanel
            id={'panel:with"special-id'}
            hidden={!id}
            style={{ borderTopLeftRadius: "14px" }}
          >
            Content
          </SettingsSourcePanel>
        </SettingsSourceGroup>,
      ),
    );
  };
  it("updates a single non-interactive outline on resize and scrolling", async () => {
    await render();
    expect(host.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const initial = host.querySelector("path")!.getAttribute("d");
    panelHeight = 400;
    await act(() => observerCallback());
    expect(host.querySelector("path")!.getAttribute("d")).not.toBe(initial);
    labelLeft = -200;
    await act(() =>
      host.querySelector(".settings-source-strip")!.dispatchEvent(new Event("scroll")),
    );
    expect(host.querySelector("path")!.getAttribute("d")).not.toContain("Q ");
    expect(host.querySelectorAll("svg")).toHaveLength(2); // outline and existing chevron
  });
  it("removes the decoration and disconnects when collapsed", async () => {
    await render();
    await render(null);
    expect(host.querySelector(".settings-source-outline")).toBeNull();
    expect(host.querySelector("[data-source-outline=ready]")).toBeNull();
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it("keeps the normal card fallback when layout is hidden", async () => {
    panelHeight = 0;
    await render();
    expect(host.querySelector(".settings-source-outline")).toBeNull();
    expect(host.querySelector("[data-source-panel]")?.className).toContain("rounded-xl border");
  });
});
