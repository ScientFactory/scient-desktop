import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  providers: [] as ReadonlyArray<unknown>,
  claim: vi.fn(),
}));

// The provider snapshots the app already holds, and the server's claim command.
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => state.providers,
}));
vi.mock("./providerSignInCommands", () => ({ claimProviderSignInPage: {} }));
vi.mock("../../state/server", () => ({ serverEnvironment: { providersValueAtom: () => ({}) } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.claim }));

import { ProviderSignInPageCoordinator } from "./ProviderSignInPageCoordinator";
import { resetProviderSignInBrowserForTests, startProviderSignIn } from "./providerSignInBrowser";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("antigravity");

function waiting(signInRequestId: string): ProviderConnectionOperation {
  return {
    operationId: "connect-1",
    method: "antigravity_google",
    status: "waiting_for_browser",
    startedAt: "2026-10-19T00:00:00.000Z",
    finishedAt: null,
    message: "Finish signing in.",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-test",
    authorizationUrlKind: "primary",
    signInRequestId,
  };
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  resetProviderSignInBrowserForTests();
});

it("claims and opens a page already waiting when it mounts, with no further snapshot", async () => {
  const open = vi.fn(async () => undefined);
  resetProviderSignInBrowserForTests({ open });
  // This client holds an id whose start reply was lost.
  const id = await new Promise<string>((received) => {
    void startProviderSignIn({
      key: { environmentId, instanceId },
      providerName: "Antigravity",
      previousOperationId: null,
      start: (signInRequestId) => {
        received(signInRequestId);
        return new Promise<never>(() => undefined);
      },
      operationOf: () => null,
    });
  });
  state.providers = [
    {
      instanceId,
      driver: ProviderDriverKind.make("antigravity"),
      displayName: "Antigravity",
      enabled: true,
      installed: true,
      version: "1.1.17",
      status: "warning",
      auth: { status: "unauthenticated", required: true },
      checkedAt: "2026-10-19T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      connection: { methods: ["antigravity_google"], canDisconnect: false, operation: waiting(id) },
    } satisfies ServerProvider,
  ];
  state.claim.mockResolvedValue({ _tag: "Success", value: { granted: true } });

  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<ProviderSignInPageCoordinator />));

  await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  expect(state.claim).toHaveBeenCalledTimes(1);
  expect(state.claim.mock.calls[0]![0]).toMatchObject({
    environmentId,
    input: { instanceId, operationId: "connect-1", signInRequestId: id },
  });
});
