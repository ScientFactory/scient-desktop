import type * as GTReact from "gt-react";
import type { ReactNode } from "react";

/**
 * English gt-react for unit tests, whose server entry needs a provider: replaces only the
 * context-bound parts, as T3's PullRequestThreadDialog.test.ts does. Use it as
 * `vi.mock("gt-react", async (o) => (await import(…)).englishGTReact(await o()))`.
 */
export function englishGTReact(actual: typeof GTReact): typeof GTReact {
  const resolve = actual.mFallback as ReturnType<typeof GTReact.useGT>;
  const passThrough = ({ children }: { readonly children?: ReactNode }) => children;
  return {
    ...actual,
    useGT: () => resolve,
    useMessages: () => resolve as ReturnType<typeof GTReact.useMessages>,
    useLocale: () => "en",
    T: passThrough as typeof GTReact.T,
    Var: passThrough as typeof GTReact.Var,
    Branch: (({
      branch,
      children,
      ...cases
    }: {
      readonly branch?: string;
      readonly children?: ReactNode;
    } & Record<string, ReactNode>) =>
      (branch !== undefined ? cases[branch] : undefined) ?? children) as typeof GTReact.Branch,
  };
}
