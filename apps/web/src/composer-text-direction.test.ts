import { getSchemaByResolvedExtensions, resolveExtensions } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDocJson,
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerCodeExtension,
  ComposerListExtensions,
} from "./composer-rich-text-doc";
import { composerTextDirections } from "./composer-text-direction";
// SCIENT-FORK:START
import type { ContentDirection } from "./scient/bidi/contentDirection";
// SCIENT-FORK:END

const schema = getSchemaByResolvedExtensions(
  resolveExtensions([
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
      code: false,
    }),
    ComposerCodeExtension,
    ComposerCodeBlockExtension,
    ...ComposerListExtensions,
    ...ComposerBlockExtensions,
  ]),
);

// SCIENT-FORK:START — Scient passes the requested composer direction.
function directions(value: string, requested: ContentDirection = "auto") {
  const doc = ProseMirrorNode.fromJSON(
    schema,
    buildDocJson(value, (name) => ({ label: name, description: null })),
  );
  return composerTextDirections(doc, requested).blocks;
}
// SCIENT-FORK:END

describe("composerTextDirections", () => {
  it("does not count inline code toward a line's direction", () => {
    expect(directions("`useEffect` و `useLayoutEffect` في `React`")).toEqual(["rtl"]);
  });

  it("gives a list one direction, from all of its items", () => {
    expect(directions("- Vitest\n- اختبر الدالة الجديدة\n- وأضف تعليق")).toEqual(["rtl"]);
  });

  it("continues the line above until a line has letters", () => {
    expect(directions("اكتب الدالة\n\n42\nfix it")).toEqual(["rtl", "rtl", "rtl", "ltr"]);
  });

  it("keeps a code block left to right inside Arabic text", () => {
    expect(directions("اكتب الدالة\n```\n// احسب مجموع القيم هنا\n```\nثم اختبرها")).toEqual([
      "rtl",
      "ltr",
      "rtl",
    ]);
  });
  // SCIENT-FORK:START

  it("resolves ambiguous paragraphs against the whole draft and a list as one block", () => {
    expect(
      directions(
        `${"זהו מסמך עברי ארוך וברור מאוד ".repeat(4)}\nabcd אב\nabcdefghij א\n- Standard deviation and confidence interval\n- Review the complete report שלום`,
      ),
    ).toEqual(["rtl", "rtl", "ltr", "ltr"]);
  });

  it("does not reuse cached directions across preference changes", () => {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson("Hello שלום\n```\nconst value = true;\n```", () => null),
    );
    expect(composerTextDirections(doc, "rtl").blocks).toEqual(["rtl", "ltr"]);
    expect(composerTextDirections(doc, "ltr").blocks).toEqual(["ltr", "ltr"]);
    expect(composerTextDirections(doc, "auto").blocks).toEqual(["ltr", "ltr"]);
    expect(composerTextDirections(doc, "rtl").blocks).toEqual(["rtl", "ltr"]);
  });
  // SCIENT-FORK:END
});
