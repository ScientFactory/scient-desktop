export const ROLES: Readonly<Record<string, string>>;
export const PROOFS: Readonly<Record<string, ReadonlyArray<string>>>;
export function summarize(
  expected: ReadonlyArray<string>,
  steps: Readonly<Record<string, { outcome?: string }>>,
): Array<{
  role: string;
  label: string;
  ran: boolean;
  failed: Array<string>;
  missing: Array<string>;
}>;
