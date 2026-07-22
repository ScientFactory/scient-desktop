# `@scientfactory/scient-skills`

This package is the canonical app-owned source for immutable Scient built-in
skill releases. It keeps portable `SKILL.md` procedures separate from
Scient-specific release metadata and generates a runtime catalog whose content
digest is checked against those source files.

The package is not the candidate skill roadmap, a provider discovery catalog,
or project activation state. Candidate product direction remains in the Scient
documentation repository. Projects preserve selected release identities in
`.scient/skills.lock.json`; provider and agent adapters only deliver releases
that the Scient app resolves.

The portfolio contains Skill Authoring v0.1 as a user-visible, user-activated
meta-capability and Evidence to Note v0.1 as a user-visible, project-scoped
scientific skill with unmet foundations. Skill Authoring is enabled by default,
can be disabled globally, and is delivered to agents for automatic semantic
triggering while enabled. Evidence to Note is default-off, appears as latent in
project setup, and is not delivered to agents until project-scoped invocation
and its declared scientific foundations exist.
