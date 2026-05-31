# Compositional Distributional Meaning — Design Note

A reading of Coecke, Sadrzadeh & Clark, *"Mathematical Foundations for a
Compositional Distributional Model of Meaning"* (arXiv:1003.4394, "DisCoCat"),
mapped onto InfiniteContext.

This is a design note, not a committed roadmap. It exists to capture *why* the
paper is relevant and *what* the smallest useful thing we could build from it is.

## The paper in one paragraph

Vector-space ("distributional") models give you *quantitative* word meaning —
`cat` and `dog` are close because they keep similar company — but they have no
notion of grammar: a bag of word vectors can't tell "dog bites man" from "man
bites dog". Symbolic/type-logical models (pregroups, Montague) give you
*compositional* grammar but are only qualitative (true/false). DisCoCat unifies
the two by observing that both **vector spaces with tensor product** and
**pregroup grammars** are *compact closed categories*. So a sentence's grammar
reduction (e.g. `n·(nʳ·s·nˡ)·n → s` for "John likes Mary") can be *lifted* into
a linear map that consumes the word vectors and produces a single sentence
vector. Crucially, **every sentence lands in the same space `S`** regardless of
its grammatical shape, so you can compare "John likes Mary" with "John does not
like Mary" by inner product — something plain embeddings cannot do in a
principled way.

Two further points matter for us:

1. **Verbs are relations, not points.** A transitive verb has type `nʳ·s·nˡ`,
   i.e. it lives in `N ⊗ S ⊗ N` — a tensor, equivalently a function
   `subject × object → sentence`. Meaning *flows* along the wires from the
   nouns through the verb. Composition is structure-aware.

2. **Swap the scalars, swap the semantics.** Run the same construction over the
   Booleans `(B, ∨, ∧)` instead of the reals and `FVect` becomes `FRel` (sets
   and relations): you recover a Montague-style truth-theoretic / set-membership
   semantics. The fuzzy model and the symbolic model are *the same machinery
   with a different semiring*.

## Why this is relevant to InfiniteContext

Today the system is squarely in the "distributional, non-compositional" camp:

- `HierarchicalRetriever.search()` ranks records by raw vector similarity to a
  single query vector (`src/core/HierarchicalRetriever.ts`). There is no
  composition and no grammar — it's similarity over opaque embeddings.
- We *also* already have the symbolic corner, in two forms:
  `ProfileMemory` (safety-controlled key/value facts) and `UserProfileMemory`
  (typed fields by category) in `src/core/types.ts`.

So InfiniteContext is *already living on both sides of the orthogonality the
paper resolves* — fuzzy embedding recall on one side, structured fact storage on
the other — without a shared account of how they relate. DisCoCat's thesis (same
compact-closed structure, `R` vs `B` scalars) is a clean conceptual frame for
that split, and directly informs the open "unify the two profile models"
question: they are the relational (`FRel`) projection of the same memory.

Two concrete weaknesses in pure-embedding memory that the paper speaks to:

- **Negation.** Cosine similarity puts "I like cilantro" and "I do *not* like
  cilantro" right next to each other — they share almost all their tokens. A
  memory system that confidently recalls the opposite of a stored preference is
  actively harmful. The paper's `not` construction (the swap matrix
  `[[0,1],[1,0]]`, and the orthogonal-negation idea from Widdows [41]) is a
  principled handle on this.
- **Relational queries.** "Who did X recommend to Y" is a typed,
  subject–verb–object shape, not a similarity blob. The verb-as-tensor view is
  how you'd represent and query that compositionally.

## What we could build (smallest → largest)

### A. Negation-aware retrieval — **implemented**
Detect negation scope in a query and apply an orthogonal-complement transform so
"not X" ranks *away* from X instead of next to it. Self-contained: a transform
over existing vectors plus a query-side parser hook. No new storage, no grammar
engine. Directly extracts the paper's most practical idea.

Shipped in `src/core/NegationAwareRetrieval.ts`:
- `parseNegation()` — lightweight, clause-local negation-scope parser (cues:
  `not`, `no`, `without`, `never`, `n't` contractions, …).
- `orthogonalNegation()` — Widdows orthogonal negation: Gram-Schmidt the negated
  directions, then project the query onto their orthogonal complement.
- `buildNegationAwareQueryVector()` — orchestration; returns exactly
  `embed(query)` when no negation is present, so every text query can route
  through it safely.

Wired into `MemoryManager.searchMemory()` for text queries (opt out with
`negationAware: false`). Covered by `tests/core/NegationAwareRetrieval.test.ts`.

### B. Typed relational memory layer (medium)
Store `(subject, relation, object)` with the relation as a tensor/role, enabling
structure-aware composition and relational queries. This is the verb-as-`N⊗S⊗N`
idea. It also gives the two profile models a principled home: facts become typed
relations rather than two ad-hoc shapes.

### C. Full DisCoCat sentence encoder (large, research)
A pregroup type-assigner + reduction-to-linear-map pipeline producing sentence
vectors in a shared `S`. High ambition, high cost, uncertain ROI inside a
production memory system. Documented here for completeness; not proposed now.

## Honest caveats

- The paper is a *mathematical foundation* — the authors explicitly leave
  implementation and corpus evaluation to future work. Verb tensors are
  `dim(N)²·dim(S)` in size; naive realizations don't scale, and learning them
  from data is its own research problem.
- Modern sentence embeddings already fold a lot of compositional behavior into
  one space empirically. The defensible, non-duplicative wins for us are the
  places embeddings provably misbehave — **negation** chief among them — not
  re-deriving sentence vectors we already get from a model.

## Status & next

**A is implemented** (see above). Natural follow-ups, in order:
- Use the `FVect`/`FRel` framing to guide the eventual unification of
  `ProfileMemory` and `UserProfileMemory` (option B territory).
- Optionally extend negation handling to *stored* memories, not just queries.
- Treat C (a full DisCoCat sentence encoder) as inspiration, not a deliverable.
