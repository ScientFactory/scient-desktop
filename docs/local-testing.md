# Local App Testing

Use the localhost application for normal feature, UI, and server testing. You
do not need to download or package Scient for each change.

## Start the app

From the repository root:

```sh
bun install
bun run dev
```

The runner prints and normally opens the local application URL. Keep that
terminal running while you test, and stop the app with `Ctrl+C`.

## Test an isolated branch or worktree

When another Scient instance may be running, give the test its own data and
ports. Use a short, unique name for the feature:

```sh
SCIENT_TEST_DIR="$(mktemp -d /tmp/scient-local.XXXXXX)"

env -u SYNARA_AUTH_TOKEN SYNARA_DEV_INSTANCE=feature-name \
  bun run dev -- --home-dir "$SCIENT_TEST_DIR" --dry-run

env -u SYNARA_AUTH_TOKEN SYNARA_DEV_INSTANCE=feature-name \
  bun run dev -- --home-dir "$SCIENT_TEST_DIR"
```

The dry run prints the resolved server port, web port, and data directory
without starting the app. Check that they do not conflict with another running
instance, then use the URL printed by the real run. The temporary directory
keeps test settings, projects, and history separate from the normal app.

## Choose the right test surface

Localhost is the default for testing product flows, UI behavior, server logic,
settings, persistence, and most provider interactions.

Use a packaged desktop build when the behavior depends on Electron or the
installed application itself, including installation, signing, updates,
packaged assets, native menus, window lifecycle, or operating-system
integration.

Passing a localhost test does not prove that packaging or updating works.
Likewise, creating a packaged build is usually unnecessary when validating an
ordinary product change.
