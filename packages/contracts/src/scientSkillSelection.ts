import * as Schema from "effect/Schema";

/** Current-composer selections. Kept separate from augmented provider text. */
export const SelectedScientSkillNames = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
).check(Schema.isMaxLength(200));
