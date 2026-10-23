import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { type ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  ComposerPendingUserInputPanel,
  type ComposerPendingUserInput,
} from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt: ComposerPendingUserInput = {
  requestId: RuntimeRequestId.make("request-1"),
  responseCapability: "live" as const,
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
  dismissible: true,
};

async function renderPanel(
  _fixture: _Fixture,
  pendingUserInput: ComposerPendingUserInput = prompt,
) {
  return await renderMarkup(
    _fixture,
    <ComposerPendingUserInputPanel
      pendingUserInputs={[pendingUserInput]}
      cwd="/repo"
      threadRef={threadRef}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />,
  );
}

describe("ComposerPendingUserInputPanel", () => {
  it("renders the header as a disclosure control for the question body", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const markup = await renderPanel(_fixture);

    const toggle = markup.match(/<button[^>]*data-pending-user-input-toggle="[^"]*"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain('data-pending-user-input-toggle="expanded"');
    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain('type="button"');

    const controlledId = toggle?.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeDefined();
    expect(markup).toMatch(new RegExp(`<div[^>]*\\sid="${controlledId}"`));
  });

  it("offers dismiss only for async questions", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    expect(await renderPanel(_fixture)).toContain("data-pending-user-input-dismiss");
    expect(await renderPanel(_fixture, { ...prompt, dismissible: false })).not.toContain(
      "data-pending-user-input-dismiss",
    );
  });

  it("starts expanded so the question and its options are visible", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const markup = await renderPanel(_fixture);

    expect(markup).toContain("Approach");
    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("Big bang");
  });

  it("links URLs in the question text", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const url = "https://accounts.t3.codes/device?user_code=RTJS-TQGS";
    const question = prompt.questions[0]!;
    const markup = await renderPanel(_fixture, {
      ...prompt,
      questions: [{ ...question, question: `Authorize BeeBox at ${url} and confirm.` }],
    });

    expect(markup).toMatch(new RegExp(`<a[^>]*href="${url.replace(/[?.]/g, "\\$&")}"`));
  });
});

it("keeps reply feedback next to the available question", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const markup = await renderPanel(_fixture, {
    ...prompt,
    responseError: "Your response could not be sent. Try again.",
  });
  expect(markup).toContain('role="alert"');
  expect(markup).toContain("Your response could not be sent. Try again.");
  expect(markup).toContain("Which approach should the migration take?");
});

async function _cleanupFixture0(_fixture: _Fixture) {
  for (const root of _fixture.root0.splice(0)) await act(async () => await root.unmount());
  _clearOwnedDOM(_fixture);
  vi.unstubAllGlobals();
}
async function renderMarkup(_fixture: _Fixture, node: ReactNode): Promise<string> {
  const container = document.body.appendChild(_ownDOM(_fixture, document.createElement("div")));
  const root = _fixture.stack.use(
    await _fixtureRender(null, { container: container, router: false }),
  );
  _fixture.root0.push(root);
  await act(async () => await root.rerender(node));
  return container.innerHTML;
}

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    root0: [] as Screen[],
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

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
