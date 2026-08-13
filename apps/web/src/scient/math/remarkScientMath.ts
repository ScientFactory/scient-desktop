import type { Options as ReactMarkdownOptions } from "react-markdown";
import remarkMath from "remark-math";

/** Entry for react-markdown's `remarkPlugins`; single dollars are how models write inline math. */
export const remarkScientMath = [remarkMath, { singleDollarTextMath: true }] satisfies NonNullable<
  ReactMarkdownOptions["remarkPlugins"]
>[number];

const MATH_CODE_CLASS_NAME = "language-math";

/**
 * Recognizes the `<code>` nodes remark-math produces. It also tags them
 * `math-inline`/`math-display`, but sanitization keeps only `language-*`
 * classes, so inline versus display is decided by the surrounding element.
 */
export function isScientMathCodeClassName(className: string | undefined): boolean {
  return className !== undefined && className.split(/\s+/).includes(MATH_CODE_CLASS_NAME);
}
