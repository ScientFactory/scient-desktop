/** Give ordinary text around a table its own paragraph spacing in Word.
 * A flowing Word table has no outside top/bottom margin. Pandoc's adjacent
 * paragraphs therefore need styles with the gap on the table-facing edge.
 */
import { attrOf, childBlockLists, customStyleDiv, type PandocNode } from "./pandocAst.ts";

function ordinaryParagraph(block: PandocNode): boolean {
  if (block.t === "Para" || block.t === "Plain") return true;
  if (block.t !== "Div") return false;
  const attributes = attrOf(block);
  if (
    attributes === null ||
    attributes[0] !== "" ||
    attributes[1].length > 0 ||
    attributes[2].some(([key]) => key !== "dir")
  ) {
    return false;
  }
  const children = childBlockLists(block)[0];
  return children?.length === 1 && ordinaryParagraph(children[0]!);
}

/** Style only adjacent body paragraphs; headings, lists, and captions retain their semantics. */
export function spaceTextAroundTables(blocks: Array<PandocNode>): void {
  const visit = (list: Array<PandocNode>): void => {
    for (const block of list) {
      for (const child of childBlockLists(block)) visit(child);
    }
    for (const [index, block] of list.entries()) {
      if (!ordinaryParagraph(block)) continue;
      const afterTable = list[index - 1]?.t === "Table";
      const beforeTable = list[index + 1]?.t === "Table";
      if (!afterTable && !beforeTable) continue;
      const style = afterTable
        ? beforeTable
          ? "Scient Between Tables"
          : "Scient After Table"
        : "Scient Before Table";
      list[index] = customStyleDiv(style, [block]);
    }
  };
  visit(blocks);
}
