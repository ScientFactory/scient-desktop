import { TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vite-plus/test";

import { insertLibraryCitation, libraryCitationQuery } from "./libraryCitation";
import { ScientProseMirrorSession } from "./session";

function sessionWithCaretAfter(source: string, marker: string) {
  const session = new ScientProseMirrorSession({ source, revision: "r0" });
  let position = -1;
  session.state.doc.descendants((node, pos) => {
    if (position >= 0 || !node.isText || !node.text?.includes(marker)) return;
    position = pos + node.text.indexOf(marker) + marker.length;
  });
  session.applyTransaction(
    session.state.tr.setSelection(TextSelection.create(session.state.doc, position)),
    "user",
  );
  return session;
}

describe("Library citation in Markdown", () => {
  it("finds the key being typed after [@ and nowhere else", () => {
    expect(
      libraryCitationQuery(sessionWithCaretAfter("As shown [@lov\n", "[@lov").state),
    ).toMatchObject({ query: "lov" });
    expect(libraryCitationQuery(sessionWithCaretAfter("As shown [@\n", "[@").state)).toMatchObject({
      query: "",
    });
    expect(libraryCitationQuery(sessionWithCaretAfter("mail x@lov\n", "x@lov").state)).toBeNull();
    expect(libraryCitationQuery(sessionWithCaretAfter("`[@lov`\n", "[@lov").state)).toBeNull();
  });

  it("writes a Pandoc citation the document saves as [@key], absorbing a typed ]", () => {
    const session = sessionWithCaretAfter("As shown [@lov.\n", "[@lov");
    const caret = session.state.selection.from;
    const typed = session.state.tr.insertText("]", caret);
    session.applyTransaction(typed.setSelection(TextSelection.create(typed.doc, caret)), "user");
    const query = libraryCitationQuery(session.state);
    if (!query) throw new Error("Expected a citation query.");
    const transaction = insertLibraryCitation(session.state, query, "lovelace1843notes");
    if (!transaction) throw new Error("Expected a citation.");
    session.applyTransaction(transaction, "user");
    expect(session.session.draftSource).toBe("As shown [@lovelace1843notes].\n");
  });
});
