import { describe, expect, it, vi } from "vite-plus/test";

import { createPreviewHostClaim, type PreviewHostClaim } from "./previewHostOwnership";

let nextTabId = 0;

/** A same-origin frame is its own Web Locks client, like another app window. */
function openWindow(stack: DisposableStack): { locks: LockManager; close: () => void } {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const close = () => frame.remove();
  stack.defer(close);
  return { locks: frame.contentWindow!.navigator.locks, close };
}

function claim(stack: DisposableStack, tabId: string, locks: LockManager): PreviewHostClaim {
  const claimed = createPreviewHostClaim(tabId, locks);
  stack.defer(claimed.start());
  return claimed;
}

const expectRole = (claimed: PreviewHostClaim, role: ReturnType<PreviewHostClaim["role"]>) =>
  vi.waitFor(() => expect(claimed.role()).toBe(role));

function setup(stack: DisposableStack) {
  const tabId = `ownership-tab-${nextTabId++}`;
  return { stack, tabId, first: openWindow(stack), second: openWindow(stack) };
}

describe("createPreviewHostClaim", () => {
  it("lets one window host and passes the tab on when the host window closes", async () => {
    using stack = new DisposableStack();
    const env = setup(stack);
    const first = claim(env.stack, env.tabId, env.first.locks);
    await expectRole(first, "host");
    const second = claim(env.stack, env.tabId, env.second.locks);
    await expectRole(second, "elsewhere");

    env.first.close();

    await expectRole(second, "host");
  });

  it("moves the tab to the window that asks to show it, and back when that window lets go", async () => {
    using stack = new DisposableStack();
    const env = setup(stack);
    const first = claim(env.stack, env.tabId, env.first.locks);
    await expectRole(first, "host");
    const second = createPreviewHostClaim(env.tabId, env.second.locks);
    const withdrawSecond = second.start();
    env.stack.defer(withdrawSecond);
    await expectRole(second, "elsewhere");

    second.showHere();
    await expectRole(second, "host");
    await expectRole(first, "elsewhere");

    withdrawSecond();
    await expectRole(first, "host");
  });

  it("gives the tab to a window that shows it when the host does not", async () => {
    using stack = new DisposableStack();
    const env = setup(stack);
    const background = claim(env.stack, env.tabId, env.first.locks);
    await expectRole(background, "host");
    const showing = claim(env.stack, env.tabId, env.second.locks);
    await expectRole(showing, "elsewhere");

    await showing.setDisplayed(true);

    await expectRole(showing, "host");
    await expectRole(background, "elsewhere");
  });

  it("keeps the tab with a host that shows it", async () => {
    using stack = new DisposableStack();
    const env = setup(stack);
    const host = claim(env.stack, env.tabId, env.first.locks);
    await host.setDisplayed(true);
    await expectRole(host, "host");
    const other = claim(env.stack, env.tabId, env.second.locks);
    await expectRole(other, "elsewhere");

    await other.setDisplayed(true);

    expect(other.role()).toBe("elsewhere");
    expect(host.role()).toBe("host");
  });

  it("hands the tab to a waiting window that shows it when the host stops showing it", async () => {
    using stack = new DisposableStack();
    const env = setup(stack);
    const host = claim(env.stack, env.tabId, env.first.locks);
    await host.setDisplayed(true);
    await expectRole(host, "host");
    const other = claim(env.stack, env.tabId, env.second.locks);
    await other.setDisplayed(true);
    await expectRole(other, "elsewhere");

    await host.setDisplayed(false);

    await expectRole(other, "host");
    await expectRole(host, "elsewhere");
  });

  it("keeps hosting a tab nobody shows, so its page survives", async () => {
    using stack = new DisposableStack();
    const env = setup(stack);
    const host = claim(env.stack, env.tabId, env.first.locks);
    await host.setDisplayed(true);
    await expectRole(host, "host");
    const roles: string[] = [];
    host.subscribe(() => roles.push(host.role()));
    const other = claim(env.stack, env.tabId, env.second.locks);
    await expectRole(other, "elsewhere");

    await host.setDisplayed(false);

    expect(roles).toEqual([]);
    expect(other.role()).toBe("elsewhere");
  });
});
