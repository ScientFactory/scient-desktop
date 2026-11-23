---
name: scient-skill-authoring
description: Make, write, review, shorten, improve or test a Scient skill; turn a recurring workflow into reusable agent guidance. Use connector-authoring when new service access or tools are needed. A review-only request produces findings, not an installed skill.
---

# Scient skill authoring

Deliver the skill the user asked for, in the home they asked for, with a description that makes it load at the right time and an honest account of how it was tested. Drafted, saved, active and actually discovered are different states; say which you reached. A review-only request ends with findings.

## Write it

Start from the user's real task and any example they gave. A skill earns its place when it captures know-how the agent would otherwise lack, for a task that recurs. Read `references/writing-for-agents.md` before drafting or reviewing; the essentials:

- The **description** is how an agent finds an automatic skill: the words the user would say, one trigger per distinct case, and the nearest neighbouring skill it should not be confused with. Make a skill explicit (chosen by the user) when it is a mode the user should deliberately enter.
- The body states the **outcome**, the steps or rules that aren't obvious, and a **finish line** the agent can check for each step ("every comment answered", not "respond to the comments").
- Say what to do rather than what not to do; use one well-known term where a sentence would do; leave out what the model already does and what tools and Scient's instructions already say. Write plain prose that keeps related actions together.
- Move rarely needed detail into resource files and say when to read them. Link copyrighted or restricted checklists rather than reproducing them.

## Save it in the right home

Use the home the user asked for. For a personal skill, read the existing one with `scient_skill_read` before changing it, save with `scient_skill_save`, and read `status`, `active` and `message`: a name that collides with a built-in or add-on skill is saved but withheld. For a project skill, write `.scient/skills/<name>/SKILL.md` in an initialized Scient project, with the frontmatter `name` matching the folder; the folder holds `SKILL.md` and its resources, without a `scient.skill.json`, and unrelated folders stay as they are. Whether a skill is on, and whether it runs automatically or only when chosen, are Settings choices, not frontmatter.

## Test it

Run the skill on the user's example, on a disposable copy if it writes files, and compare the result with what they wanted. Try a nearby request where it should not apply. File validation alone is not a test; if you can't test, say what is untested.

For a fuller comparison, when the user asks for one, run the same inputs in fresh contexts with and without the skill, keep expected answers out of the test agent's reach, and record whether the skill loaded separately from how well the task went.

Reply with where the skill lives (a link for files you wrote; the name and status for a personal skill), what you tested and what happened, and what remains untested. Claim automatic discovery only after you've seen an agent load it on its own.
