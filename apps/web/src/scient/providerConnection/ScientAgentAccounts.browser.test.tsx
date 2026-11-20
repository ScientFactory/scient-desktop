import { render } from "../../../test/render";
import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionAccount,
  type ProviderConnectionOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const SIGN_IN_FAILURE =
  "Provider 'kimi-code' requires interactive prompts which are not supported in RPC mode. Use the terminal UI to log in.";

vi.mock("../../state/server", () => ({
  serverEnvironment: { startProviderConnection: "start" },
}));
vi.mock("../../state/use-atom-command", () => ({
  // Every command fails the way the server rejects a sign-in it could not start.
  useAtomCommand: () => async () =>
    AsyncResult.failure(Cause.fail({ _tag: "ProviderConnectionError", message: SIGN_IN_FAILURE })),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));
vi.mock("gt-react", async (importOriginal) =>
  (await import("~/scient/testing/englishGTReact")).englishGTReact(await importOriginal()),
);

import { ScientAgentAccounts } from "./ScientAgentAccounts";

const account = (id: string, name: string): ProviderConnectionAccount => ({
  id,
  name,
  kind: "account",
  connected: false,
  canDisconnect: false,
});

const accounts = [
  account("openai-codex", "ChatGPT Plus/Pro (Codex)"),
  account("anthropic", "Anthropic (Claude Pro/Max)"),
  account("zai", "Z.AI"),
  account("kimi-code", "Kimi Code"),
  account("openrouter", "OpenRouter"),
  account("github-copilot", "GitHub Copilot"),
  account("cursor", "Cursor (Claude, GPT, etc.)"),
  account("devin", "Devin"),
];

const provider = (
  operation: ProviderConnectionOperation | null,
  listed: ReadonlyArray<ProviderConnectionAccount> = accounts,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make("scient"),
  driver: ProviderDriverKind.make("scient"),
  displayName: "Scient",
  enabled: true,
  installed: true,
  version: "0.1.13",
  status: "ready",
  auth: { status: "unknown", required: false },
  checkedAt: "2026-11-20T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: [],
    canDisconnect: false,
    operation: null,
    accountOperation: operation,
    accounts: listed,
  },
});

const failedOperation: ProviderConnectionOperation = {
  operationId: "connect-1",
  method: "scient_agent_account",
  status: "failed",
  startedAt: "2026-11-20T00:00:00.000Z",
  finishedAt: "2026-11-20T00:00:01.000Z",
  message: SIGN_IN_FAILURE,
  account: "kimi-code",
};

const screenshots = import.meta.env.VITE_SCIENT_AGENT_ACCOUNTS_SCREENSHOTS as string | undefined;
const theme = import.meta.env.VITE_SCIENT_AGENT_ACCOUNTS_THEME === "dark" ? "dark" : "light";

const ui = (
  operation: ProviderConnectionOperation | null,
  listed: ReadonlyArray<ProviderConnectionAccount> = accounts,
) => (
  <div className="w-[420px] bg-popover p-4 text-foreground">
    <ScientAgentAccounts
      environmentId={EnvironmentId.make("local")}
      provider={provider(operation, listed)}
    />
  </div>
);

describe("ScientAgentAccounts in a browser", () => {
  it("says once why a sign-in failed", async () => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await page.viewport(520, 640);
    await using screen = await render(ui(null), { router: false });
    // The click's own failure, then the failed operation the server records for it.
    await screen.getByRole("button", { name: "Sign in" }).nth(3).click();
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await screen.rerender(ui(failedOperation));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(`Kimi Code: ${SIGN_IN_FAILURE}`);
    if (screenshots) await page.screenshot({ path: `${screenshots}/failure-${theme}.png` });
    expect(screen.container.textContent?.split(SIGN_IN_FAILURE).length).toBe(2);
  });

  it("does not take another account's failure for the failed sign-in", async () => {
    const signedIn = [
      {
        ...account("anthropic", "Anthropic (Claude Pro/Max)"),
        connected: true,
        canDisconnect: true,
      },
      ...accounts.filter((entry) => entry.id !== "anthropic"),
    ];
    await using screen = await render(ui(failedOperation, signedIn), { router: false });
    // Signing out of Anthropic fails with the same text the Kimi Code sign-in failed with.
    await screen.getByRole("button", { name: "Sign out" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent(SIGN_IN_FAILURE);
    await expect.element(screen.getByRole("alert")).not.toHaveTextContent("Kimi Code");
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent(`Kimi Code: ${SIGN_IN_FAILURE}`);
  });

  it("keeps a heading opaque over the rows scrolled under it", async () => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await page.viewport(520, 640);
    await using screen = await render(ui(null), { router: false });
    const heading = screen.getByText("Sign in with an account").element() as HTMLElement;
    const list = heading.closest(".overflow-y-auto") as HTMLElement;
    // Half of Kimi Code's row is under the heading.
    list.scrollTop =
      (screen.getByText("Kimi Code").element() as HTMLElement).closest("li")!.offsetTop -
      heading.offsetHeight / 2;
    await expect.poll(() => list.scrollTop).toBeGreaterThan(0);
    if (screenshots) await page.screenshot({ path: `${screenshots}/scrolled-${theme}.png` });
    // The heading's color, painted alone, must cover what is under it.
    const color = getComputedStyle(heading).backgroundColor;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const opaque = context.getImageData(0, 0, 1, 1).data[3] === 255;
    expect(opaque, color).toBe(true);
  });
});
