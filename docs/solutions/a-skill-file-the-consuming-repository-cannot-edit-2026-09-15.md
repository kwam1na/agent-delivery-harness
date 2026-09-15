---
title: A skill file the consuming repository cannot edit
date: 2026-09-15
category: harness
module: agent-skills-provider
problem_type: boundary_error
component: documentation
resolution_type: scope_correction
applies_when:
  - "A ticket asks for an edit to a file under .claude/skills or .agents/skills"
  - "A workflow rule has to reach the lens subagents of every future round"
  - "An edit lands somewhere other than the path you typed"
tags: [agent-skills, provenance, symlink, receipts, round-brief, review-cost]
---

# A skill file the consuming repository cannot edit

## Problem

V26-2082 asked for two things: the runbook should describe lens worktrees that
are reused across a delivery's rounds rather than recreated per round, and
`.claude/skills/obtain-review/references/round-brief-template.md` should carry
the scoped-check rule so that every lens brief hands the rule to the lens. The
second half looked like the cheaper of the two — one section appended to a
markdown file the repository has in its own tree.

It is not in the repository's own tree. The edit was written, and
`git status` in the delivery worktree reported a modified file at a path nobody
had typed:

```
 M .agent-skills/generations/e63b1f2b…/skills/obtain-review/references/round-brief-template.md
```

`.claude/skills/obtain-review` is a relative symlink into
`.agent-skills/current/skills/`, which is the installed generation of the
agent-skills release. Writing through the symlink writes into the generation.
That generation is receipted: its `release-manifest.json` pins every file's
`sha256`, and the manifest's own `contentSha256` covers the set. The edit made
one disagree with the other, checkable in three lines:

```sh
node -e 'const fs=require("fs"),c=require("crypto");
const r=".agent-skills/generations/<digest>";
const f=JSON.parse(fs.readFileSync(r+"/release-manifest.json","utf8")).files
  .find(x=>x.path.includes("round-brief-template"));
console.log(c.createHash("sha256").update(fs.readFileSync(r+"/"+f.path)).digest("hex")===f.sha256);'
```

The sensor that notices is `npm run sensor:policy`, whose installed-generation
integrity check rejects with `installed_generation_file_drift`; the closure
digest is re-checked again at install and on every pinned-root load. The
provider qualification, which is the first thing the name suggests, does *not*
notice: it pins two installed provider modules and never reads the skills tree.
An executor who edits the template and runs that one to see whether it mattered
gets a green that means nothing.

The symlink is not an accident to route around. It is what makes Codex
(`.agents/skills`) and Claude Code (`.claude/skills`) discover the same workflow
bytes from one immutable root — the claim `qualifications/composition-baseline.json`
states in as many words. A consuming repository that can edit those bytes has no
such claim.

## Decision

Revert the generation-root edit; leave the template to the repository that owns
it. The rule still has to reach the lens, so the runbook — which this repository
does own — carries it as a block written *as brief text*, addressed to the lens,
that the executor appends verbatim to every filled brief. The template's own
copy is filed as `kwam1na/agent-skills#69`, and the runbook says that the block
is a stopgap until that ships.

Two properties made this an acceptable substitution rather than a workaround.
The rule is one the executor applies per round anyway, so the paste has an owner
and a moment. And the runbook is pinned by `docs/docs-references.test.ts`, which
harvests every `npm run` script and every run-event kind the page names, so the
block's commands cannot rot into names the tree does not have — which is more
than the template's own text gets from this side of the boundary.

## What generalizes

**A path under `.claude/skills` or `.agents/skills` is a discovery surface, not
a source.** Before planning an edit there, resolve it: `readlink -f` says
whether you are about to write into the installed generation. If you are, the
work belongs to the providing repository, whatever the ticket's scope paragraph
says — and the ticket is usually right that the *text* is needed, only wrong
about which repository can hold it.

**Where a rule lives decides whether it is followed.** The scoped-check rule
existed, in force, in a wave's instructions, while a round-3 lens ran a near-full
suite for 23 minutes — because the brief it was handed did not carry it. A rule
addressed to a subagent has to be in the bytes that subagent receives. Anywhere
else it is a rule about the executor's memory.

## Also landed here

The runbook's round-cost paragraph. `review.round.closed`'s `cost` is the host's
own subagent accounting and under-reports by construction: the executor's
context is outside it, so is a subagent the host did not break out, and so is
every round under a host that meters nothing. `coverage` is where that is said —
`complete`, `partial`, or the `unreported` shape that carries no total — and a
round's total is a floor on what the round cost, not the cost.
