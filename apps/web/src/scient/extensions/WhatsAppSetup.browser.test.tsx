import { PrimaryConnectionTarget, RelayConnectionTarget } from "@t3tools/client-runtime/connection";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type WhatsAppLinkState, type WhatsAppStatus } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import "~/index.css";

const mocks = vi.hoisted(() => ({
  startLink: vi.fn(),
  cancelLink: vi.fn(),
  unlinkWhatsApp: vi.fn(),
  remote: false,
}));

const environmentId = EnvironmentId.make("whatsapp-test");
const localTarget = new PrimaryConnectionTarget({
  environmentId,
  label: "My computer",
  httpBaseUrl: "http://127.0.0.1:3000/",
  wsBaseUrl: "ws://127.0.0.1:3000/",
});
const remoteTarget = new RelayConnectionTarget({ environmentId, label: "Lab server" });

vi.mock("./ExtensionsPage", () => ({
  MutedLine: ({ children }: { readonly children: ReactNode }) => <p>{children}</p>,
  useExtensionsEnvironment: () => ({ environmentId, canWrite: true }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { readonly children?: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => (mocks.remote ? null : localTarget.httpBaseUrl),
  useEnvironment: () => {
    const target = mocks.remote ? remoteTarget : localTarget;
    return { label: target.label, entry: { target } };
  },
}));

const statusAtom = Atom.make<WhatsAppStatus | null>(null).pipe(Atom.keepAlive);

vi.mock("./whatsAppState", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  const { Atom } = await import("effect/reactivity");
  const { promiseCommandRun } = await import("../../../test/promiseCommandRun");
  const permission = Atom.make(true);
  const command = (label: string, submit: (target: unknown) => unknown) => ({
    label,
    permissionAtom: () => permission,
    run: promiseCommandRun((_registry: unknown, target: unknown) => submit(target)),
  });
  return {
    useWhatsAppStatus: () => ({ status: useAtomValue(statusAtom), error: null }),
    startWhatsAppLink: command("start-link", mocks.startLink),
    cancelWhatsAppLink: command("cancel-link", mocks.cancelLink),
    unlinkWhatsApp: command("unlink", mocks.unlinkWhatsApp),
  };
});

import { WhatsAppSetup } from "./WhatsAppSetup";

const deviceName = "My Computer";
const account = "+15550101000";
const linked = { _tag: "Linked", account, connection: "connected" } as const;
const target = { environmentId, input: {} };
const button = (name: string) => page.getByRole("button", { name, exact: true });

async function setup(
  initial: WhatsAppLinkState = { _tag: "Unlinked" },
  { remote = false, platformSupported = true } = {},
) {
  mocks.remote = remote;
  for (const command of [mocks.startLink, mocks.cancelLink, mocks.unlinkWhatsApp])
    command.mockReset();

  const stack = new AsyncDisposableStack();
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  const update = (state: WhatsAppLinkState) =>
    act(() => registry.set(statusAtom, { state, deviceName, platformSupported }));
  try {
    await update(initial);
    const screen = stack.use(
      await render(
        <RegistryContext value={registry}>
          <WhatsAppSetup />
        </RegistryContext>,
        { router: false },
      ),
    );
    return { screen, update, [Symbol.asyncDispose]: () => stack.disposeAsync() };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

describe("WhatsApp setup", () => {
  it("starts linking only after the person confirms the risks", async () => {
    await using _fixture = await setup();
    await button("Link WhatsApp").click();
    const warning = page.getByRole("dialog", { name: "Before you link" });
    await expect.element(warning).toBeVisible();
    await expect.element(warning.getByText(/have been restricted/)).toBeVisible();
    expect(mocks.startLink).not.toHaveBeenCalled();

    await warning.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(warning).not.toBeInTheDocument();
    expect(mocks.startLink).not.toHaveBeenCalled();

    await button("Link WhatsApp").click();
    await warning.getByRole("button", { name: "Link WhatsApp", exact: true }).click();
    expect(mocks.startLink).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("replaces the QR image when the status stream publishes a fresh code", async () => {
    await using fixture = await setup({ _tag: "AwaitingScan", qr: "first-code", issuedAt: 1 });
    const code = fixture.screen.getByRole("img", { name: "WhatsApp code" });
    await expect.element(code).toBeVisible();
    const path = code.element().querySelector("path")?.getAttribute("d");
    expect(path).toBeTruthy();

    await fixture.update({ _tag: "AwaitingScan", qr: "next-code", issuedAt: 2 });
    await expect.element(code).toBeVisible();
    const replacement = code.element().querySelector("path")?.getAttribute("d");
    expect(replacement).toBeTruthy();
    expect(replacement).not.toBe(path);
  });

  it("shows the linked account and confirms before unlinking", async () => {
    await using fixture = await setup(linked);
    await expect.element(fixture.screen.getByText(`Linked to ${account}`)).toBeVisible();
    await button("Unlink").click();
    const confirm = page.getByRole("alertdialog", { name: "Unlink WhatsApp?" });
    await expect.element(confirm).toBeVisible();
    expect(mocks.unlinkWhatsApp).not.toHaveBeenCalled();

    await confirm.getByRole("button", { name: "Unlink", exact: true }).click();
    expect(mocks.unlinkWhatsApp).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("warns when the link runs on a remote machine and still lets the person link", async () => {
    await using fixture = await setup({ _tag: "Unlinked" }, { remote: true });
    await expect.element(fixture.screen.getByText(/Scient is running on Lab server/)).toBeVisible();
    await button("Link WhatsApp").click();
    const warning = page.getByRole("dialog", { name: "Before you link" });
    await expect.element(warning.getByText(/Scient is running on Lab server/)).toBeVisible();
    await warning.getByRole("button", { name: "Link WhatsApp", exact: true }).click();
    expect(mocks.startLink).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("hides linking on unsupported computers", async () => {
    await using fixture = await setup({ _tag: "Unlinked" }, { platformSupported: false });
    await expect
      .element(fixture.screen.getByText(/isn't available on this computer/))
      .toBeVisible();
    await expect.element(button("Link WhatsApp")).not.toBeInTheDocument();
  });

  it("shows the restriction's end in local time when WhatsApp provides it", async () => {
    const until = Date.UTC(2026, 10, 29, 10, 30);
    await using fixture = await setup({ _tag: "Restricted", until });
    const date = new Date(until).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
    await expect
      .element(fixture.screen.getByText(`WhatsApp has restricted this account until ${date}.`))
      .toBeVisible();
    await fixture.update({ _tag: "Restricted" });
    await expect
      .element(
        fixture.screen.getByText("WhatsApp has restricted this account for now.", {
          exact: true,
        }),
      )
      .toBeVisible();
  });
});
