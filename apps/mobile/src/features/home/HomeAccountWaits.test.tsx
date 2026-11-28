import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../threads/ThreadAccountRequests", () => ({
  ThreadAccountRequests: (props: {
    readonly environmentId: string;
    readonly scope: { readonly outside: ReadonlySet<string> };
  }) => <p data-environment={props.environmentId}>{[...props.scope.outside].join(",")}</p>,
}));

import { HomeAccountWaits } from "./HomeAccountWaits";

const home = "env-home" as EnvironmentId;
const lab = "env-lab" as EnvironmentId;

it("shows each environment's waits with no chat, even on a home with no threads", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const shown = () =>
    [...host.querySelectorAll("p")].map((node) => [node.dataset.environment, node.textContent]);
  await act(async () =>
    root.render(
      <HomeAccountWaits environmentIds={[home, lab]} threads={[]} placement="empty-home" />,
    ),
  );
  // Nothing listed, so every wait of both environments counts as outside any chat.
  expect(shown()).toEqual([
    ["env-home", ""],
    ["env-lab", ""],
  ]);
  const threads = [
    { environmentId: home, id: "thread-a" },
    { environmentId: lab, id: "thread-b" },
  ] as unknown as ReadonlyArray<EnvironmentThreadShell>;
  await act(async () =>
    root.render(
      <HomeAccountWaits environmentIds={[home, lab]} threads={threads} placement="list" />,
    ),
  );
  // Each environment's own listed chats are left to their thread cards.
  expect(shown()).toEqual([
    ["env-home", "thread-a"],
    ["env-lab", "thread-b"],
  ]);
  act(() => root.unmount());
});
