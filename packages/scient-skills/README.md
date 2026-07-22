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

The portfolio contains Skill Authoring v0.1, Medical Exam Study v0.1, and
Evidence to Note v0.1. Skill Authoring and Medical Exam Study are user-visible,
user-activated capabilities delivered to agents for automatic semantic
triggering while enabled. Skill Authoring is enabled by default. Medical Exam
Study is an optional domain skill that is disabled by default and proposes its
durable study workspace only after use; activation itself does not modify a
project. Evidence to Note is a user-visible, project-scoped scientific skill
with unmet foundations. It is default-off, appears as latent in project setup,
and is not delivered to agents until project-scoped invocation and its declared
scientific foundations exist.

Built-in releases may carry UTF-8 text assets under `assets/`. These assets
participate in the immutable content digest and are delivered beside
`SKILL.md`, so relative paths remain portable and a template cannot change
without producing a new release identity. Broader reference, script, and
binary-resource delivery remains future work rather than implied support.
