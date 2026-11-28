import { expect, it } from "@effect/vitest";
import * as SchemaAST from "effect/SchemaAST";
import { AccountsState, READABLE_LIST_NAMES } from "./AccountPersistence.ts";
import { readRemovedAccounts, RemovedAccount, RemovedAccounts } from "./removedAccounts.ts";

/** A list, optional or not: one bad record of it would otherwise fail the whole read. */
const isList = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isArrays(ast) || (SchemaAST.isUnion(ast) && ast.types.some(isList));

it("reads every list of the stored state record by record", () => {
  // A list missing here makes one bad entry of it keep every login from opening.
  const lists = Object.entries(AccountsState.fields)
    .filter(([, field]) => isList(field.ast))
    .map(([name]) => name);
  expect(lists.length).toBeGreaterThan(0);
  expect(lists.filter((name) => !READABLE_LIST_NAMES.has(name))).toEqual([]);
});

it("reads the removed list removal by removal", () => {
  // The removed list is one list of removals: read through `readRemovedAccounts`, entry by entry.
  const [element] = SchemaAST.isArrays(RemovedAccounts.ast) ? RemovedAccounts.ast.rest : [];
  expect(element).toBe(RemovedAccount.ast);
  const read = readRemovedAccounts([{ removalId: "no row" }]);
  expect(read).toEqual({ removed: [], dropped: [{ removalId: "no row" }], read: [] });
});
