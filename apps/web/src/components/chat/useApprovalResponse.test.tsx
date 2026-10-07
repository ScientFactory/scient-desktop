import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useApprovalResponse } from "./useApprovalResponse";

const native = vi.hoisted(() => ({ respond: vi.fn() }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { respondToApproval: Symbol("native") },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => native.respond }));

type Props = Omit<Parameters<typeof useApprovalResponse>[0], "setRespondingRequestIds">;
let root: Root;
let reply: ReturnType<typeof useApprovalResponse>;
let responding: RuntimeRequestId[];
const requestId = RuntimeRequestId.make("live-request");
const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("current-thread");
const onResponseError = vi.fn();

function Probe(props: Props) {
  const [ids, setIds] = useState<RuntimeRequestId[]>([]);
  const respond = useApprovalResponse({ ...props, setRespondingRequestIds: setIds });
  useLayoutEffect(() => {
    reply = respond;
    responding = ids;
  }, [respond, ids]);
  return null;
}

beforeEach(() => {
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.respond.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  onResponseError.mockReset();
  root = createRoot(container as unknown as HTMLElement);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

async function render(approvals: Props["approvals"], activeThread = threadId) {
  await act(() =>
    root.render(
      <Probe
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
    await render([]);
    await render([{ requestId, responseCapability: "live" }]);
    await act(async () => {
      await reply(requestId, "accept");
    });
    expect(native.respond).toHaveBeenLastCalledWith({
      environmentId,
      input: { threadId, requestId, decision: "accept" },
    });
    expect(responding).toEqual([]);
    const next = ThreadId.make("new-current-thread");
    await render([{ requestId, responseCapability: "live" }], next);
    await act(async () => {
      await reply(requestId, "decline");
    });
    expect(native.respond).toHaveBeenLastCalledWith({
      environmentId,
      input: { threadId: next, requestId, decision: "decline" },
    });
  });

  it("never dispatches historical or already settled requests", async () => {
    await render([{ requestId, responseCapability: "not_resumable" }]);
    await act(async () => {
      await reply(requestId, "accept");
    });
    await render([]);
    await act(async () => {
      await reply(requestId, "accept");
    });
    expect(native.respond).not.toHaveBeenCalled();
  });

  it("fences a repeated click while the same native response is in flight", async () => {
    let finish!: (value: { _tag: "Success"; value: undefined }) => void;
    native.respond.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render([{ requestId, responseCapability: "live" }]);
    let first!: ReturnType<typeof reply>;
    await act(() => {
      first = reply(requestId, "accept");
    });
    expect(responding).toEqual([requestId]);
    await act(async () => {
      await reply(requestId, "decline");
    });
    expect(native.respond).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ _tag: "Success", value: undefined });
      await first;
    });
    expect(responding).toEqual([]);
  });
});
