---
name: brainstorming
description: First stage of the feature workflow (brainstorming → grill-me → writing-plans → subagent-driven-development) for topup-project. Turns a rough idea into an approved design doc by exploring the code and the MTOPUP/SPNV databases, asking questions one at a time, and proposing 2-3 approaches. Use this whenever the user wants to build, add or change a feature, endpoint, report or query in this project ("I want to get X data", "add an API for Y", "create function for this SQL") and no approved design exists yet — even if they don't say "brainstorm". Also use when they say /brainstorming or ask to start the workflow.
---

# Brainstorming

Turn an idea into a design the user has approved, before anyone writes code. In this project a
"quick" endpoint can hide a 25-second query or the wrong table, so a short design conversation up
front saves rework later.

Reply in the language the user is writing in (they switch between English, Thai and Lao).

## Before you start

Read `.claude/skills/writing-plans/references/project-conventions.md`. It has the project layout,
the known tables, the query-speed rules and the "production DB is read-only" rule. Don't ask the
user anything that file or the code already answers.

## Process

### 1. Understand the current state

- Look at the relevant routes, controllers, services and helpers.
- If the idea touches data, look at the database yourself with read-only queries: table and column
  names, a few sample rows (`TOP 5 … WITH (NOLOCK)`), row counts, indexes, date ranges, and the
  distinct values of status/result columns. Users often paste a SQL query — run it (with a timeout)
  and time it; how fast it is decides the design.
- Note anything surprising (no index, view that times out, columns with secrets, data only for one
  year) — these become design constraints.

### 2. Ask questions — one per message

Ask only what you can't find out yourself. One question per message, multiple choice when possible,
with your recommended option first and the reason. Typical things to settle:

- Who calls this endpoint and what they need to see (fields, totals, sort order).
- Filters and which are required (phone, date, partner `userId`, status).
- Date range defaults and limits, paging defaults.
- Which server/table is the source of truth when more than one fits.

Stop asking when you could describe the feature to another developer without guessing.

### 3. Propose 2-3 approaches

For each: what it does, which tables/queries, measured or expected speed, trade-offs. Lead with
your recommendation and why. Use real numbers from step 1 ("one day with count: 4 s; whole view:
25 s") instead of adjectives.

### 4. Present the design in sections

Walk through it in short sections and confirm each before moving on:

1. API: method, path, query params (types, defaults, limits), example request.
2. Response: example JSON with real-looking values, error cases and messages.
3. Data: tables, joins, filters, paging, measured query time.
4. Code: which files change in route → controller → service, which helpers are reused.
5. Out of scope: what this deliberately doesn't do.

### 5. Write the design doc

Save it to `docs/specs/YYYY-MM-DD-<topic>-design.md` (today's date, kebab-case topic) with the
sections above plus "Open questions" (empty if none). Write it for a developer who hasn't seen this
conversation.

### 6. Hand off

Tell the user where the doc is and that the next step is **grill-me**, which stress-tests the design
before planning. Then invoke the `grill-me` skill with the doc path. If the user wants to skip it,
go straight to `writing-plans` — it's their call.

## Things to avoid

- Writing code or editing project files (other than the design doc) at this stage.
- Asking several questions in one message — the user answers the first and the rest get lost.
- Designing around a query you haven't timed.
- Renaming existing routes or response fields; the user picks route paths.
