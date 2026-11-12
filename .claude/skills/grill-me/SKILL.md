---
name: grill-me
description: Second stage of the feature workflow (brainstorming → grill-me → writing-plans → subagent-driven-development) for topup-project. Interviews the user relentlessly about a design or plan — one question at a time, walking every branch of the decision tree — until there are no unresolved decisions left, then records the answers in the design doc. Use after brainstorming produces a design doc, when the user says "grill me", "stress-test this", "poke holes in this", "what am I missing", or /grill-me, or when they bring an existing spec/plan they want challenged before it is built.
---

# Grill me

Interview the user about every decision in the design until you both understand it the same way.
The goal is to find the gaps now — edge cases, missing defaults, conflicting requirements — while
fixing them costs a sentence instead of a rewrite.

Reply in the language the user is writing in.

## Input

A design doc, usually `docs/specs/YYYY-MM-DD-<topic>-design.md` from brainstorming. If none is
given, look for the newest file in `docs/specs/`; if there is none, ask the user what to grill (or
suggest running brainstorming first). Also read
`.claude/skills/writing-plans/references/project-conventions.md`.

## How to grill

1. **Map the decision tree first.** Read the design and list (to yourself) every decision it makes
   or silently assumes: inputs, defaults, limits, validation, data source, joins, empty results,
   errors, performance, naming, what's out of scope. Order them so earlier answers unlock later ones.

2. **One question per message.** For each question:
   - State the decision and why it matters, in one or two lines.
   - Give your recommended answer and the reason.
   - Offer the alternatives (multiple choice when it fits).

3. **Answer it yourself when you can.** If the code or the database can settle it (does the column
   allow NULL? how many rows per day? how long does this query take? what does the existing endpoint
   return for an empty page?), check with read-only queries and tell the user what you found instead
   of asking. Only ask the user about things that are genuinely their decision.

4. **Follow every branch.** When an answer opens new questions, go down that branch before moving on.
   Don't accept "whatever you think" on something with real trade-offs — give your recommendation and
   ask them to confirm it.

5. **Keep a running list** of decided items so nothing is asked twice.

## Areas this project tends to get wrong

Probe these unless the design already settles them clearly:

- **Speed:** has the main query been timed on live data with realistic filters? What happens with
  the widest allowed date range? Is every joined log table bounded by date?
- **Unbounded reads:** can a caller request all rows / all dates? What are the max range and max
  page size?
- **Phone input:** all formats go through `normalizePhone`? Sender vs receiver vs either?
- **Dates:** default range, date-only `to` meaning end of day, server local time, old years living
  in `*_BackUp_YYYY` tables.
- **Status:** what counts as success for this table, exactly (result code, step)?
- **Empty and edge results:** no rows, page past the end (totals become 0 with `COUNT(*) OVER ()`),
  self-transfers, NULL result rows.
- **Errors:** 400 messages for each bad input; what is logged on 500.
- **Exposure:** any column that shouldn't leave the server (password hashes, internal IPs)?
- **Compatibility:** does it change any existing route path, query param or response field?

## Finish

When nothing is left unresolved:

1. Update the design doc: fold each decision into the right section and add a
   "Decisions (grill-me)" list with question → answer. Clear "Open questions".
2. Show the user a short summary of what changed in the design.
3. Ask whether to continue to **writing-plans**. If yes, invoke the `writing-plans` skill with the
   doc path.

## Things to avoid

- Batching questions. One per message, every time.
- Asking what you could have looked up.
- Writing code. This stage only changes the design doc.
