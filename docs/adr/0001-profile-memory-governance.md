# ADR 0001 — Two profile-memory shapes, one governance contract

- Status: Accepted
- Date: 2026-06-01

## Context

The codebase ended up with two independently-introduced "profile memory" types:

- **`ProfileMemory`** (from the safety-controls work): a flat, manually-authored
  `{ userId, domain, key, value, tags, … }` fact that carries the full
  governance lifecycle (`retentionPolicy`, `expiresAt`, `sensitivity`,
  `deletionStatus`, redaction/deletion tombstones). Stored in
  `safetyProfileMemories`, set via `upsertProfileMemory()`.

- **`UserProfileMemory`** (from the profile-extraction work): a structured
  aggregate of confidence-weighted `UserProfileMemoryField`s grouped into
  `preferences` / `interests` / `emotionalState` / `behavioralPatterns`, each
  field carrying provenance (`confidence`, `evidence`, `sourceEpisodeIds`,
  `traceIds`, `lastObservedAt`). Auto-extracted from episodes, stored in
  `profileMemories`, retrieved as snippets injected into search.

The near-identical names suggested redundancy, and there was pressure to "unify
the two models" into one type.

A code audit found the substantive problem is **not** the duplication — it is a
**governance gap**: the safety pipeline (`listMemories`, `redactMemories`,
`deleteMemories`, `exportMemories`) traversed chunks and `safetyProfileMemories`
but **never touched `profileMemories`**. Auto-extracted inferences about a user —
*including `emotionalState`* — therefore escaped redaction, query-scoped
deletion, retention, and export. For a system that advertises production safety
controls, that is a right-to-access / right-to-erasure defect.

## Decision

**Keep the two shapes; unify them under a single governance contract.**

We explicitly reject merging the two into one type. They model genuinely
different things:

- `ProfileMemory` is a hand-authored, governed key/value *assertion*.
- `UserProfileMemory` is an *inferred, probabilistic* structured belief set with
  provenance.

Collapsing them would force nullable-field sprawl (provenance on manual facts,
governance on every inferred field) and erase the clean, distinct lifecycles.
The durable fix is to make the *relationship* explicit, not to flatten it: every
class of stored memory — chunks, manual profile facts, and extracted profile
aggregates — must answer to the same safety surface.

## Consequences

Implemented:

- `UserProfileMemory` gained governance tombstones (`deletionStatus`,
  `deletedAt`, `redactedAt`, `deletionReason`).
- `MemorySafety` gained `userProfileMatchesQuery`, `redactUserProfile`,
  `deleteUserProfileMarker`, `sanitizeUserProfileForExport`.
- `listMemories` / `exportMemories` now return a `userProfiles` array;
  `redactMemories` / `deleteMemories` mutate extracted profiles via
  `mutateMemories`.
- Extracted profiles are matched **only** by broad, user-scoped (or unscoped)
  queries. A query pinning a chunk-specific facet (`domain`, `bucket`, `tag`,
  `sensitivity`) deliberately excludes them — preserving targeted redaction
  semantics and existing `{matched, changed}` counts.
- Deleted profiles are filtered from normal reads/snippets but retained as
  redacted tombstones for auditability.

Boundary / future work (intentionally out of scope here):

- Field-level governance facets (per-field `sensitivity`/`tags`) are not added;
  profiles are governed at the aggregate level. If targeted per-field redaction
  of inferences is needed later, add those facets and extend
  `userProfileMatchesQuery`.
- The `ProfileMemory` / `UserProfileMemory` names remain (renaming would break
  the public API). This ADR is the disambiguation of record.

## Alternatives considered

1. **Merge into one type.** Rejected: lossy, nullable-heavy, conflates authored
   facts with inferred beliefs.
2. **Leave them separate and independent.** Rejected: leaves the governance gap,
   the actual liability.
