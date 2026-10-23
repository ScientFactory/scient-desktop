import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { useLayoutEffect, useState } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import { useApprovalResponse } from "./useApprovalResponse";

const native = vi.hoisted(() => ({ respond: vi.fn() }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { respondToApproval: Symbol("native") },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => native.respond }));

type Props = Omit<Parameters<typeof useApprovalResponse>[0], "setRespondingRequestIds">;

const requestId = RuntimeRequestId.make("live-request");
const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("current-thread");
const onResponseError = vi.fn();

function Probe({ _fixture, ...props }: Props & { _fixture: _Fixture }) {
  const [ids, setIds] = useState<RuntimeRequestId[]>([]);
  const respond = useApprovalResponse({ ...props, setRespondingRequestIds: setIds });
  useLayoutEffect(() => {
    _fixture.publishReply(respond);
    _fixture.publishResponding(ids);
  }, [_fixture, respond, ids]);
  return null;
}

async function _setupFixture0(_fixture: _Fixture) {
  const container = document.createElement("div");
  native.respond.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  onResponseError.mockReset();
  _fixture.root0 = _fixture.stack.use(await _fixtureRender(null, { container, router: false }));
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
}

async function render(_fixture: _Fixture, approvals: Props["approvals"], activeThread = threadId) {
  await act(
    async () =>
      await _fixture.root0.rerender(
        <Probe
          _fixture={_fixture}
          environmentId={environmentId}
          threadId={activeThread}
          approvals={approvals}
          onResponseError={onResponseError}
        />,
      ),
  );
}

describe("live approval response ownership", () => {
  it("responds to a late-arriving live request and uses the current thread after navigation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, []);
    await render(_fixture, [{ requestId, responseCapability: "live" }]);
    await act(async () => {
      await _fixture.reply(requestId, "accept");
    });
    expect(native.respond).toHaveBeenLastCalledWith({
      environmentId,
      input: { threadId, requestId, decision: "accept" },
    });
    expect(_fixture.responding).toEqual([]);
    const next = ThreadId.make("new-current-thread");
    await render(_fixture, [{ requestId, responseCapability: "live" }], next);
    await act(async () => {
      await _fixture.reply(requestId, "decline");
    });
    expect(native.respond).toHaveBeenLastCalledWith({
      environmentId,
      input: { threadId: next, requestId, decision: "decline" },
    });
  });

  it("never dispatches historical or already settled requests", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, [{ requestId, responseCapability: "not_resumable" }]);
    await act(async () => {
      await _fixture.reply(requestId, "accept");
    });
    await render(_fixture, []);
    await act(async () => {
      await _fixture.reply(requestId, "accept");
    });
    expect(native.respond).not.toHaveBeenCalled();
  });

  it("fences a repeated click while the same native response is in flight", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let finish!: (value: { _tag: "Success"; value: undefined }) => void;
    native.respond.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render(_fixture, [{ requestId, responseCapability: "live" }]);
    let first!: ReturnType<typeof _fixture.reply>;
    await act(() => {
      first = _fixture.reply(requestId, "accept");
    });
    expect(_fixture.responding).toEqual([requestId]);
    await act(async () => {
      await _fixture.reply(requestId, "decline");
    });
    expect(native.respond).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ _tag: "Success", value: undefined });
      await first;
    });
    expect(_fixture.responding).toEqual([]);
  });
});

function _createFixture() {
  let responding: RuntimeRequestId[] = [];
  let _published_reply = undefined! as ReturnType<typeof useApprovalResponse>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get responding() {
      return responding;
    },
    publishResponding(next: RuntimeRequestId[]) {
      responding = next;
    },
    get reply() {
      return _published_reply;
    },
    publishReply(next: typeof _published_reply) {
      _published_reply = next;
    },

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
