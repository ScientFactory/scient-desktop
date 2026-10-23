import { act as _fixtureAct, render as _fixtureRender, type Screen } from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionOperation,
  type ServerProvider,
} from "@t3tools/contracts";

import { expect, it, vi } from "vite-plus/test";

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
import { resetProviderSignInForTests, startProviderSignIn } from "./providerSignInFlow";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("antigravity");
const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-test";

function waiting(signInRequestId: string): ProviderConnectionOperation {
  return {
    operationId: "connect-1",
    method: "antigravity_google",
    status: "waiting_for_browser",
    startedAt: "2026-10-19T00:00:00.000Z",
    finishedAt: null,
    message: "Finish signing in.",
    authorizationUrl: url,
    authorizationUrlKind: "primary",
    signInRequestId,
  };
}

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
  resetProviderSignInForTests();
}

it("claims and opens a page already waiting when it mounts, with no further snapshot", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const open = vi.fn(async () => undefined);
  resetProviderSignInForTests({ open });
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
  state.claim.mockResolvedValue({
    _tag: "Success",
    value: { granted: true, authorizationUrl: url },
  });

  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixtureAct(async () => await _fixture.root0!.rerender(<ProviderSignInPageCoordinator />));

  await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  expect(open).toHaveBeenCalledWith(url);
  expect(state.claim).toHaveBeenCalledTimes(1);
  expect(state.claim.mock.calls[0]![0]).toMatchObject({
    environmentId,
    input: { instanceId, operationId: "connect-1", signInRequestId: id },
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
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
