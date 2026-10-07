import type { Node, Slice } from "@tiptap/pm/model";
import { ReplaceStep, type Mappable } from "@tiptap/pm/transform";

/** Explicit document operations change body structure and preamble in one undo event.
 * History lives only in this editor session; recovery persists the accepted source.
 */
export class LatexTitleStep extends ReplaceStep {
  constructor(
    from: number,
    to: number,
    slice: Slice,
    readonly sourceBefore: string,
    readonly sourceAfter: string,
  ) {
    super(from, to, slice);
  }
  override invert(doc: Node): LatexTitleStep {
    const inverse = super.invert(doc);
    return new LatexTitleStep(
      inverse.from,
      inverse.to,
      inverse.slice,
      this.sourceAfter,
      this.sourceBefore,
    );
  }
  override map(mapping: Mappable): LatexTitleStep | null {
    const mapped = super.map(mapping);
    return mapped
      ? new LatexTitleStep(
          mapped.from,
          mapped.to,
          mapped.slice,
          this.sourceBefore,
          this.sourceAfter,
        )
      : null;
  }
  override merge(): null {
    return null;
  }
}
