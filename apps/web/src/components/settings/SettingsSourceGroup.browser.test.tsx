import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";
import "../../index.css";
import {
  SettingsSourceGroup,
  SettingsSourcePanel,
  SettingsSourceStrip,
  SettingsSourceStripItem,
} from "./SettingsSourceStrip";

describe("shared raised settings surface", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.host = document.createElement("div");
    _fixture.host.style.width = "600px";
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  const render = async (_fixture: _Fixture, id: string | null = 'panel:with"special-id') => {
    await act(
      async () =>
        await _fixture.root0.rerender(
          <SettingsSourceGroup activePanelId={id}>
            <SettingsSourceStrip label="Sources">
              <div aria-hidden style={{ width: 20, flexShrink: 0 }} />
              <SettingsSourceStripItem
                controls={'panel:with"special-id'}
                expanded={id !== null}
                label="Python"
                icon={<span />}
                separated={false}
                onToggle={() => {}}
              />
              <div aria-hidden style={{ width: 1000, flexShrink: 0 }} />
            </SettingsSourceStrip>
            <SettingsSourcePanel
              id={'panel:with"special-id'}
              hidden={!id}
              style={{ borderTopLeftRadius: "14px", height: 200 }}
            >
              Content
            </SettingsSourcePanel>
          </SettingsSourceGroup>,
        ),
    );
  };
  it("removes the decoration and disconnects when collapsed", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    await render(_fixture);
    await render(_fixture, null);
    expect(_fixture.host.querySelector(".settings-source-outline")).toBeNull();
    expect(_fixture.host.querySelector("[data-source-outline=ready]")).toBeNull();
    expect(_fixture.disconnect).toHaveBeenCalledOnce();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  const disconnect = stack.use(vi.spyOn(ResizeObserver.prototype, "disconnect"));
  return {
    disconnect,
    host: undefined! as HTMLDivElement,
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
