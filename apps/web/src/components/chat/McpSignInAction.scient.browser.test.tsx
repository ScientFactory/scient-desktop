import "~/index.css";
import { EnvironmentId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { McpSignInAction } from "./McpSignInAction";

const fixture = vi.hoisted(() => ({
  start: vi.fn(),
  complete: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("../../state/threads", () => {
  const start = { permissionAtom: () => Atom.make(true) };
  const complete = {};
  return {
    threadEnvironment: {
      mcpSignInStart: start,
      mcpSignInComplete: complete,
      mcpSignedInAtom: () => Atom.make(false),
    },
  };
});
vi.mock("../../state/use-atom-command", async () => {
  const { threadEnvironment } = await import("../../state/threads");
  return {
    useAtomCommand: (command: unknown) =>
      command === threadEnvironment.mcpSignInStart ? fixture.start : fixture.complete,
  };
});
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: fixture.openExternal } }),
}));

function setup() {
  fixture.start.mockResolvedValue({
    _tag: "Success",
    value: { authorizationUrl: "https://linear.example/authorize", signedInAt: null },
  });
  return {
    [Symbol.dispose]: () => {
      fixture.start.mockReset();
      fixture.complete.mockReset();
      fixture.openExternal.mockReset();
    },
  };
}

const action = (
  <McpSignInAction
    environmentId={EnvironmentId.make("synthetic")}
    threadId={ThreadId.make("thread-mcp")}
    providerThreadId={ProviderThreadId.make("provider-thread-mcp")}
    server="linear"
    noticeAt={0}
  />
);

it("finishes without a pasted address once the agent reports the browser reached it", async () => {
  using _fixture = setup();
  fixture.complete.mockResolvedValue({ _tag: "Success", value: { signedInAt: "2026-01-01" } });
  await using _screen = await render(action);
  await page.getByRole("button", { name: "Sign in to linear" }).click();
  await page.getByRole("button", { name: "Open sign-in page" }).click();
  expect(fixture.openExternal).toHaveBeenCalledWith("https://linear.example/authorize");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(fixture.complete).toHaveBeenCalledWith({
    environmentId: "synthetic",
    input: {
      threadId: "thread-mcp",
      providerThreadId: "provider-thread-mcp",
      server: "linear",
    },
  });
});

it("keeps the paste field when the agent never reports the sign-in", async () => {
  using _fixture = setup();
  fixture.complete.mockResolvedValue({ _tag: "Failure", cause: undefined });
  await using _screen = await render(action);
  await page.getByRole("button", { name: "Sign in to linear" }).click();
  await page.getByRole("button", { name: "Open sign-in page" }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Address of the page your browser opened" }))
    .toBeVisible();
});
