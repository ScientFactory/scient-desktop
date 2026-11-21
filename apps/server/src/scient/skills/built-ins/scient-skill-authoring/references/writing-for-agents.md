# Writing for agents

How to write the text an agent follows: a skill, an instructions file, a document a skill points to.

## The description is a pointer

When agents browse or search the available skills, the name and description are what they choose from, so the wording, not the body, decides when an automatic skill is used. An explicit skill appears only when the user selects it. Put the word users actually say first ("grill", "references", "statistics"), give one trigger per distinct case the skill handles, and drop synonyms that rename the same case. Keep descriptions short. A skill that never loads can't be fixed by improving its body.

## Steps and reference

A skill holds **steps** (what the agent does, in order) and **reference** (rules and facts it consults). Put first what every run needs; move what only some runs need into a resource file, with a line saying when to read it. Keep a concept's rule, exceptions and caveats together under one heading. A body that is too long thins the agent's attention even when every line is true.

## Finish lines

End every step on a **completion criterion** the agent can check: "every number in the draft has a ledger row" beats "check the numbers". A vague finish line ("understand the data") invites stopping early. Demanding, checkable criteria ("every comment answered", "the count of references checked out of the total") drive thorough work without listing every action.

## Say what to do

Name the behaviour you want ("answer conditionally until the change is in the manuscript") rather than the one you don't. A prohibition puts the unwanted behaviour into the agent's mind. Keep "never" for hard guardrails, and pair it with the positive target.

## Leading words

Use a short, well-known term instead of a sentence: _ledger_, _frontier_, _preregistered_, _independent unit_, _tight_ loop, a check that goes _red_. The model already knows what they mean, so one word anchors a whole behaviour. Reach for an existing term before coining one.

## Prune

- **No-ops:** delete any sentence the model would obey anyway. If a word is too weak to change behaviour ("be careful"), use a stronger one rather than adding a sentence.
- **One source of truth:** say each thing once.
- **Don't copy the environment:** tool descriptions, schemas, `--help` output and Scient's own instructions are already visible. Write only what the agent can't look up: the unwritten convention, the reason for a choice, the trap no tool reports.
- **Remove stale lines:** text written to patch one failure in one test, provenance notes and dated remarks don't belong in the instructions.
