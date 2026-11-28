import { describe, expect, it } from "vite-plus/test";
import { loginFieldsKit } from "./scientLoginFields.ts";
import { secureRandom, strongPassword } from "./scientStrongPassword.ts";

/** A form's box limits, and its words as the page reads them (`text`). */
const rules = ({
  text = "",
  ...overrides
}: Partial<Parameters<typeof strongPassword>[0]> & { text?: string } = {}) => {
  const said = loginFieldsKit.newPasswordWords(text);
  return {
    minLength: -1,
    maxLength: -1,
    pattern: "",
    passwordRules: "",
    statedMinLength: said.minLength,
    statedMaxLength: said.maxLength,
    required: said.required,
    noSymbols: said.noSymbols,
    refusal: said.refusal,
    ...overrides,
  };
};

describe("strongPassword", () => {
  it("makes 20 characters of every kind unless the page says otherwise", () => {
    const made = strongPassword(rules(), secureRandom)!;
    expect(made).toHaveLength(20);
    for (const kind of [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]) expect(made).toMatch(kind);
  });

  it("follows what the page states: its words, its passwordrules and its pattern", () => {
    expect(
      strongPassword(
        rules({ text: "Between 8 and 12 characters. Letters and numbers only." }),
        secureRandom,
      ),
    ).toMatch(/^[a-zA-Z0-9]{12}$/);
    expect(
      strongPassword(
        rules({ maxLength: 64, passwordRules: "minlength: 24; required: upper; allowed: [-_]" }),
        secureRandom,
      ),
    ).toMatch(/^[a-zA-Z0-9_-]{24}$/);
    expect(strongPassword(rules({ text: "At least 32 characters" }), secureRandom)).toHaveLength(
      32,
    );
    // The box's own pattern is matched whole, as the browser checks it: here 16 at most, no symbols.
    expect(strongPassword(rules({ pattern: "[A-Za-z0-9]{8,16}" }), secureRandom)).toMatch(
      /^[A-Za-z0-9]{16}$/,
    );
  });

  it("offers nothing a page's rules can't take", () => {
    expect(strongPassword(rules({ maxLength: 3 }), secureRandom)).toBeUndefined();
    expect(
      strongPassword(
        rules({ text: "Must include a symbol. No special characters." }),
        secureRandom,
      ),
    ).toMatch(/^[a-zA-Z0-9]{20}$/);
    expect(strongPassword(rules({ pattern: "[0-9]{4}" }), secureRandom)).toBeUndefined();
  });
});
