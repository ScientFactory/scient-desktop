import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ComposerCommandMenu } from "./ComposerCommandMenu";

describe("ComposerCommandMenu", () => {
  it("renders slash commands with their descriptions", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "slash:model",
            type: "slash-command",
            command: "model",
            label: "/model",
            description: "Switch response model for this thread",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="slash:model"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("/model");
    expect(markup).toContain("Switch response model for this thread");
  });

  it("shows the app source for an app skill", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:codex:browser",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "browser",
              path: "/Users/maria/.codex/plugins/browser/skills/browser/SKILL.md",
              scope: "user",
              enabled: true,
            },
            label: "Browser",
            description: "Open and control the in-app browser",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="skill"
        activeItemId="skill:codex:browser"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("Browser");
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain(">App Skill</span>");
    expect(markup).toContain("Open and control the in-app browser");
    expect(markup).toContain("<svg");
  });

  it("identifies built-in Scient skills while preserving project ownership", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
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
    expect(markup).toContain('<img aria-hidden="true" class="shrink-0 size-3.5 sm:size-3"');
  });

  it("shows the repo source for a slash skill", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:codex:ask-matt",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "ask-matt",
              displayName: "Ask Matt",
              path: "/skills/ask-matt/SKILL.md",
              scope: "repo",
              enabled: true,
            },
            label: "/skill:ask-matt",
            description: "Find the right skill or workflow",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="skill:codex:ask-matt"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('<span class="text-secondary-label">/skill:</span>Ask Matt');
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain("lucide-folder");
    expect(markup).toContain(">Repo</span>");
    expect(markup).toContain("Find the right skill or workflow");
  });
});
