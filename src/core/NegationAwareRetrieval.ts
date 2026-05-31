/**
 * Negation-aware retrieval.
 *
 * Plain cosine similarity places "I like cilantro" and "I do not like cilantro"
 * almost on top of each other — they share nearly all of their tokens — so a
 * naive vector memory will happily recall the opposite of what was asked. This
 * module gives queries a principled handle on negation.
 *
 * The transform is Widdows' orthogonal negation (Widdows 2003, ref [41] in
 * Coecke/Sadrzadeh/Clark, arXiv:1003.4394): to represent "a NOT b" we project
 * the query vector onto the orthogonal complement of the negated concept(s),
 * removing the component that points along what the user excluded. Results then
 * rank by similarity to the *remaining* meaning.
 *
 * Parsing is deliberately a lightweight heuristic — it finds negation cues and
 * their clause-local scope. It is not a grammar engine; the value is in the
 * geometric transform, which degrades gracefully when the parse is imperfect.
 */

import { Vector } from './types.js';

export interface ParsedNegation {
  /** The non-negated remainder of the query (may be empty). */
  positive: string;
  /** Negated concept phrases, one per detected negation cue. */
  negatedPhrases: string[];
  hasNegation: boolean;
}

/** Tokens that close a negation's scope. */
const SCOPE_BOUNDARIES = new Set([
  'and', 'or', 'but', 'however', 'although', 'though', 'because', 'so', 'yet',
]);

/** Standalone negation cue words. */
const NEGATION_WORDS = new Set([
  'not', 'no', 'never', 'without', 'nor', 'none', 'cannot', 'nothing',
  'neither', 'excluding', 'minus', 'sans',
]);

/** Negated auxiliary contractions (the negated content is what follows). */
const NEGATION_CONTRACTIONS = new Set([
  "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
  "can't", "won't", "wouldn't", "shouldn't", "couldn't", "haven't",
  "hasn't", "hadn't", "ain't", "mustn't", "needn't",
]);

/**
 * Auxiliary / light verbs stripped from the front of a negated phrase so the
 * negated *concept* surfaces, e.g. "doesn't like cilantro" -> "cilantro".
 */
const LEADING_FILLER = new Set([
  'like', 'likes', 'liked', 'want', 'wants', 'wanted', 'have', 'has', 'had',
  'do', 'does', 'did', 'be', 'is', 'are', 'was', 'were', 'been', 'being',
  'contain', 'contains', 'containing', 'include', 'includes', 'including',
  'use', 'uses', 'using', 'about', 'with', 'any', 'a', 'an', 'the', 'to',
]);

function isNegationCue(token: string): boolean {
  return NEGATION_WORDS.has(token) || NEGATION_CONTRACTIONS.has(token) || token.endsWith("n't");
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/([,.;:!?])/)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Split a query into its positive remainder and the negated concept phrases.
 *
 * Heuristic: on each negation cue, consume following tokens up to the next
 * scope boundary or punctuation as the negated phrase, dropping leading
 * auxiliary/filler words. Everything else is the positive remainder.
 */
export function parseNegation(query: string): ParsedNegation {
  const tokens = tokenize(query);
  const positiveTokens: string[] = [];
  const negatedPhrases: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (isNegationCue(token)) {
      const phrase: string[] = [];
      let j = i + 1;
      // Skip leading filler so the negated concept surfaces.
      while (j < tokens.length && LEADING_FILLER.has(tokens[j])) {
        j++;
      }
      for (; j < tokens.length; j++) {
        const next = tokens[j];
        if (SCOPE_BOUNDARIES.has(next) || /^[,.;:!?]$/.test(next)) {
          break;
        }
        phrase.push(next);
      }
      if (phrase.length > 0) {
        negatedPhrases.push(phrase.join(' '));
        i = j - 1; // resume after the consumed phrase
        continue;
      }
      // Cue with no usable scope: treat as an ordinary token.
    }

    if (!/^[,.;:!?]$/.test(token)) {
      positiveTokens.push(token);
    }
  }

  return {
    positive: positiveTokens.join(' '),
    negatedPhrases,
    hasNegation: negatedPhrases.length > 0,
  };
}

function dot(a: Vector, b: Vector): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function subtractScaled(a: Vector, b: Vector, scale: number): Vector {
  return a.map((value, i) => value - scale * (b[i] ?? 0));
}

/**
 * Project `query` onto the orthogonal complement of the subspace spanned by
 * `negated`, i.e. remove every component pointing along a negated concept.
 *
 * The negated directions are Gram-Schmidt orthonormalized first so that
 * overlapping negated concepts don't over-subtract. Near-zero negated vectors
 * are ignored. Returns a new vector; the input is not mutated.
 */
export function orthogonalNegation(query: Vector, negated: Vector[]): Vector {
  const EPS = 1e-12;
  let result = [...query];

  const basis: Vector[] = [];
  for (const vec of negated) {
    // Orthogonalize this negated direction against the ones already accepted.
    let ortho = [...vec];
    for (const b of basis) {
      ortho = subtractScaled(ortho, b, dot(ortho, b));
    }
    const normSq = dot(ortho, ortho);
    if (normSq <= EPS) {
      continue; // collinear with an existing direction, or ~zero
    }
    const inv = 1 / Math.sqrt(normSq);
    const unit = ortho.map((v) => v * inv);
    basis.push(unit);
    // Remove query's component along this unit direction.
    result = subtractScaled(result, unit, dot(result, unit));
  }

  return result;
}

/**
 * Build a negation-aware query vector from raw query text.
 *
 * When the query contains no negation this returns exactly `embed(query)`, so
 * it is safe to route every string query through it. When negation is present,
 * the positive remainder is embedded and projected away from each negated
 * concept's embedding via {@link orthogonalNegation}.
 */
export async function buildNegationAwareQueryVector(
  query: string,
  embed: (text: string) => Promise<Vector>
): Promise<Vector> {
  const parsed = parseNegation(query);
  if (!parsed.hasNegation) {
    return embed(query);
  }

  // If stripping negation left nothing positive, fall back to the full query so
  // we still have a meaningful direction to project.
  const positiveText = parsed.positive.trim().length > 0 ? parsed.positive : query;
  const positiveVector = await embed(positiveText);
  const negatedVectors = await Promise.all(parsed.negatedPhrases.map((p) => embed(p)));

  return orthogonalNegation(positiveVector, negatedVectors);
}
