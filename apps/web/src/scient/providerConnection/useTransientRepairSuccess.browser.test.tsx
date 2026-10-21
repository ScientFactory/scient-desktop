import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import { useLayoutEffect, type ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import { REPAIR_SUCCESS_NOTICE_MS, useTransientRepairSuccess } from "./useTransientRepairSuccess";

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

describe("useTransientRepairSuccess", () => {
  async function _setupFixture2(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureFakeTimers());
  }

  async function _cleanupFixture3(_fixture: _Fixture) {
    vi.useRealTimers();
  }

  it("shows repair success for four seconds and ignores other runtime actions", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    _fixture.cleanup.defer(() => _cleanupFixture3(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    let notice!: ReturnType<typeof useTransientRepairSuccess>;
    function Probe() {
      const value = useTransientRepairSuccess(true);
      useLayoutEffect(() => {
        notice = value;
      });
      return null;
    }
    await mount(_fixture, <Probe />);

    await act(() => notice.reportRuntimeActionSucceeded("remove"));

    expect(notice.repairSucceededRecently).toBe(false);

    await act(() => notice.reportRuntimeActionSucceeded("repair"));

    expect(notice.repairSucceededRecently).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(REPAIR_SUCCESS_NOTICE_MS - 1));

    expect(notice.repairSucceededRecently).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(1));

    expect(notice.repairSucceededRecently).toBe(false);
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
