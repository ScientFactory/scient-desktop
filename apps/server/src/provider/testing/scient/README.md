# Scient provider protocol fixtures

`ClaudeCapabilitiesProbe.fixture.mjs` is a synthetic Claude SDK control-protocol
peer. Scient retains its consumer to check modified capability/skill handling,
strict no-MCP arguments, disabled hooks and account results through the actual
SDK serialization boundary. It neither starts Claude nor accesses an account.
The caller supplies an isolated invocation file and workspace. The peer exits
when the SDK closes its input.

Upstream removed this fixture in `05696c636e` (#22557). Keep its former
`provider/testing/ClaudeCapabilitiesProbe.fixture.mjs` path deleted; this copy
belongs to Scient's retained boundary test, not the retired upstream cases.
Its bytes and executable mode are unchanged from `pingdotgg/t3code` commit
`81dea7821dca30b417182db6fa0cb99a0195bfd8`, source path
`apps/server/src/provider/testing/ClaudeCapabilitiesProbe.fixture.mjs`.
The 2,097-byte file has SHA-256
`cf82c430a933fbd87590b9d840f2d6f0340c2dac8434c088ed02f45f9ea6ecc8`.
The root `LICENSE` retains T3 Tools Inc.'s MIT notice. This is a test-only input,
not live-provider or foreign-platform qualification.

To reproduce the import from a checkout containing that immutable commit:

```sh
git show 81dea7821dca30b417182db6fa0cb99a0195bfd8:apps/server/src/provider/testing/ClaudeCapabilitiesProbe.fixture.mjs \
  > apps/server/src/provider/testing/scient/ClaudeCapabilitiesProbe.fixture.mjs
chmod 755 apps/server/src/provider/testing/scient/ClaudeCapabilitiesProbe.fixture.mjs
shasum -a 256 apps/server/src/provider/testing/scient/ClaudeCapabilitiesProbe.fixture.mjs
```
