# Expo schema input

The received SDL is pinned to official T3 commit
`81dea7821dca30b417182db6fa0cb99a0195bfd8`, path
`apps/server/schema/expo.graphql`. Its original SHA-256 is
`099e00af4ff4ced68f00f08bf84aa1c74dc36546b863f0b890ac6ae435a225a8`.

For offline reproduction, obtain that exact blob with `git show`, then use the
installed GraphQL 16.14.1 API to produce:

```ts
printSchema(lexicographicSortSchema(buildSchema(source))).replace(/[ \t]+$/gm, "") + "\n"
```

Write the result to `expo.graphql`. Parsing before and after with
`parse(source, { noLocation: true })` produces identical ASTs. The only byte
changes remove four spaces on two blank description lines.

`scripts/fetch-expo-schema.ts` applies the same whitespace normalization to future
intentional API refreshes. Do not call its live introspection endpoint to
reproduce this frozen input. From `apps/server`, `pnpm run generate` regenerates
the client/schema TypeScript from this SDL and the checked-in operations.
