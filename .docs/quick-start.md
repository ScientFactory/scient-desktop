# Quick start

```bash
# Development (with hot reload)
bun run dev

# Desktop development
bun run dev:desktop

# Desktop development on an isolated port set
# `SYNARA_DEV_INSTANCE` is an inherited compatibility variable.
SYNARA_DEV_INSTANCE=feature-xyz bun run dev:desktop

# Production
bun run build
bun run start

# Build a shareable macOS .dmg (arm64 by default)
bun run dist:desktop:dmg

# Or from any project directory after publishing @scientfactory/cli:
npx --package @scientfactory/cli scient
```
