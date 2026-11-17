import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useImperativeHandle, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { responseContextRecord, responseContextReference } from "../../lib/composerContextRecords";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useQueuedRunEdit } from "./useQueuedRunEdit";

// Scient compositions on T3's in-place queued-run edit: the reply survives the edit,
// and the edited text's `$skill` mentions choose the message's Scient skills.

const mocks = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editQueuedRun: vi.fn<(value: unknown) => Promise<{ readonly _tag: "Success" | "Failure" }>>(),
    runs: Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }>>([]).pipe(
      Atom.keepAlive,
    ),
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.editQueuedRun,
}));

vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    threadEnvironment: {
      snapshotAtom: () => Atom.make(null),
      editQueuedRun: {},
      promoteQueuedRun: {},
    },
    environmentThreadDetails: {
      statusAtom: () => Atom.make("ready"),
      quietThreadAtom: (ref: ScopedThreadRef) =>
        Atom.make((get) => ({
          projection: {
            thread: { id: ref.threadId, activeProviderThreadId: null },
            runs: get(mocks.runs),
            messages: [],
            providerThreads: [],
            providerSessions: [],
            providerTurns: [],
          },
        })),
    },
    environmentThreadShells: {
      threadShellAtom: () => Atom.make(null),
    },
  };
});

const ENV = EnvironmentId.make("env-scient");
const THREAD: ScopedThreadRef = { environmentId: ENV, threadId: ThreadId.make("thread-scient") };
const RUN = RunId.make("run-scient");
const MESSAGE = MessageId.make("message-scient");

type HookResult = ReturnType<typeof useQueuedRunEdit>;

const reply = responseContextRecord({
  citation: {
    version: 1,
    environmentId: ENV,
    threadId: THREAD.threadId,
    messageId: MessageId.make("answer"),
    text: "The earlier answer",
    start: 0,
    end: 18,
    prefix: "",
    suffix: "",
  },
  itemId: TurnItemId.make("answer-item"),
  subagents: [],
});
const replyReference = formatInlineContextReference(responseContextReference(reply));

function Harness(props: {
  readonly hookRef: RefObject<HookResult | null>;
  readonly messages: ReadonlyArray<unknown>;
}) {
  const result = useQueuedRunEdit({
    environmentId: ENV,
    routeThreadRef: THREAD,
    threadDraftTarget: THREAD,
    activeThreadId: THREAD.threadId,
    serverProjection: {
      runs: [{ id: RUN, status: "queued" }],
      messages: props.messages,
    } as unknown as ThreadStructure,
    promptRef: { current: "" },
    composerRef: { current: null },
  });
  useImperativeHandle(props.hookRef, () => result);
  return null;
}

async function setup(messages: ReadonlyArray<unknown> = []) {
  mocks.editQueuedRun.mockReset().mockResolvedValue({ _tag: "Success" });
  appAtomRegistry.set(mocks.runs, [{ id: RUN, status: "queued" }]);
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  const hook: { current: HookResult | null } = { current: null };
  const screen = await render(
    <AppAtomRegistryProvider>
      <Harness hookRef={hook} messages={messages} />
    </AppAtomRegistryProvider>,
  );
  const current = () => {
    if (hook.current === null) throw new Error("hook did not render");
    return hook.current;
  };
  return { screen, current };
}

const content = (prompt: string, replyTo: typeof reply | null = null) => ({
  prompt,
  images: [],
  files: [],
  terminalContexts: [],
  reviewComments: [],
  previewAnnotations: [],
  threadContexts: [],
  environmentContexts: [],
  replyTo,
});

function sentInput() {
  const [call] = mocks.editQueuedRun.mock.calls;
  if (call === undefined) throw new Error("No queued edit was saved");
  return (call[0] as { readonly input: Record<string, unknown> }).input;
}

describe("useQueuedRunEdit in Scient", () => {
  it("keeps the queued message's reply above the composer and sends it again on save", async () => {
    const text = `${replyReference} Please expand on this`;
    const { screen, current } = await setup([
      { id: MESSAGE, context: { version: 1, records: [reply] } },
    ]);
    await using _screen = screen;
    await act(() => current().beginEdit({ runId: RUN, messageId: MESSAGE, text, attachments: [] }));
    const draft = useComposerDraftStore.getState().getComposerDraft(current().draftTarget);
    expect(draft?.replyTo).toEqual(reply);
    expect(draft?.prompt).toBe("Please expand on this");

    // The composer leads the saved text with the reply, as it does for a new send.
    await act(() =>
      current().saveEdit(content(`${replyReference} Please expand on it`, reply), () => {}),
    );
    expect(mocks.editQueuedRun).toHaveBeenCalledOnce();
    expect(sentInput()).toMatchObject({
      text: `${replyReference} Please expand on it`,
      edit: { context: { records: [reply] } },
    });
  });

  it.each([
    { prompt: "$analysis then $pdf the results", skills: ["analysis", "pdf"] },
    { prompt: "No skills any more", skills: [] },
  ])("chooses the Scient skills the edited text mentions: $prompt", async ({ prompt, skills }) => {
    const { screen, current } = await setup();
    await using _screen = screen;
    await act(() =>
      current().beginEdit({
        runId: RUN,
        messageId: MESSAGE,
        text: "$analysis original",
        attachments: [],
      }),
    );
    await act(() => current().saveEdit(content(prompt), () => {}));
    expect(sentInput()).toMatchObject({ selectedScientSkillNames: skills });
  });
});
