import { expect, it, vi } from "vite-plus/test";

import { electNotificationPresenter, type NotificationPresenter } from "./notificationPresenter";

function appWindow(
  name: string,
  focused: boolean,
): Disposable & {
  readonly presenter: NotificationPresenter;
  readonly focus: () => void;
} {
  const focusTarget = new EventTarget();
  const presenter = electNotificationPresenter({
    locks: navigator.locks,
    name,
    focusTarget,
    hasFocus: () => focused,
  });
  return {
    presenter,
    focus: () => focusTarget.dispatchEvent(new Event("focus")),
    [Symbol.dispose]: () => presenter.stop(),
  };
}

it("elects one presenter that focus moves and a closed window hands over", async () => {
  const lock = "test-notification-presenter";
  using first = appWindow(lock, false);
  await vi.waitFor(() => expect(first.presenter.isPresenter()).toBe(true));
  using second = appWindow(lock, true);
  using third = appWindow(lock, false);
  await vi.waitFor(() => {
    expect(second.presenter.isPresenter()).toBe(true);
    expect(first.presenter.isPresenter()).toBe(false);
  });

  first.focus();
  await vi.waitFor(() => {
    expect(first.presenter.isPresenter()).toBe(true);
    expect(second.presenter.isPresenter()).toBe(false);
  });
  expect(third.presenter.isPresenter()).toBe(false);

  first.presenter.stop();
  await vi.waitFor(() =>
    expect([second, third].filter((window) => window.presenter.isPresenter())).toHaveLength(1),
  );
});
