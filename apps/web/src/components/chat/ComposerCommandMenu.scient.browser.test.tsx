import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { ProviderDriverKind } from "@t3tools/contracts";
import { type ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerCommandMenu } from "./ComposerCommandMenu";

describe("ComposerCommandMenu", () => {
  it("identifies built-in Scient skills while preserving project ownership", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const markup = await renderMarkup(
      _fixture,
      <ComposerCommandMenu
        listId="test-suggestions"
        items={[
          {
            id: "skill:codex:pdf-authoring",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "pdf-authoring",
              path: "scient://skills/scient.pdf-authoring%400.2.0%23sha256%3Aabc",
              scope: "personal",
              enabled: true,
            },
            label: "PDF Authoring",
            description: "Create and verify PDF documents",
          },
          {
            id: "skill:codex:project-review",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "project-review",
              path: "scient://skills/project.review%400.1.0%23sha256%3Adef",
              scope: "project",
              enabled: true,
            },
            label: "Project Review",
            description: "Review this project",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="skill"
        activeItemId="skill:codex:pdf-authoring"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain(">Scient Skill</span>");
    expect(markup).toContain(">Project Skill</span>");
    expect(markup).not.toContain(">App Skill</span>");
  });
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
