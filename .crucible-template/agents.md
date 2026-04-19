# Crucible Agent Instructions

> Progressive-disclosure briefing for coding agents operating inside this
> repository via Crucible. Read top-to-bottom; stop once you have the
> context you need.

## 1. TL;DR

- You are working inside a git checkout of this project.
- Use the project's package manager (see `./init.sh` for detection order).
- Keep changes **small, reviewable, and scoped to the requested task**.
- Never push to `main` directly. Always branch → commit → open a PR.

## 2. Task Intake

Crucible will hand you a single task, typically derived from a GitHub issue
or an eval in `./eval/tasks.json`. Re-read the task body before starting.

If any part of the task is ambiguous, **ask once up front** rather than
guessing silently.

## 3. Ground Rules

1. **Stay inside the workspace.** Do not modify files outside the project
   root. Do not touch global tool configuration.
2. **No destructive git.** Never `push --force` to shared branches; never
   rewrite history already present on `origin`.
3. **No secrets.** Do not commit `.env`, credentials, or access tokens.
4. **Fail loudly.** If a command fails, surface the output - do not
   silently swallow errors.

## 4. Standard Workflow

1. `./init.sh` - install dependencies (idempotent).
2. Create a topic branch: `git checkout -b <kind>/<short-slug>`.
3. Make the minimum change required to satisfy the task.
4. Run the project's quality gates (format, lint, typecheck, tests).
5. Commit with a conventional-commit message.
6. Push the branch and open a pull request describing the change.

## 5. Deeper Context (read on demand)

<!--
  Progressive disclosure: add sections below only when the task actually
  needs them. Do NOT expand every section eagerly - that is how context
  windows die.
-->

### 5.1 Project layout

_Describe the directory structure (top-level packages, where source lives,
where tests live). Keep it scannable._

### 5.2 Build & test commands

_List the exact commands a contributor runs, e.g._

- Install: `bun install`
- Dev: `bun dev`
- Test: `bun run test`
- Lint: `bun lint`
- Typecheck: `bun typecheck`

### 5.3 Coding conventions

_File naming, import ordering, formatter, preferred patterns, gotchas._

### 5.4 Architectural notes

_Link to deeper docs (`/docs`, ADRs, RFCs) rather than inlining them._

## 6. Done-Definition

A task is only "done" when **all** of the following hold:

- [ ] The acceptance criteria in the task are satisfied.
- [ ] `./init.sh` succeeds on a clean checkout.
- [ ] Format / lint / typecheck / tests all pass.
- [ ] A PR exists with a clear title and body.
