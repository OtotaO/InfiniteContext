import {
  parseNegation,
  orthogonalNegation,
  buildNegationAwareQueryVector,
} from '../../src/core/NegationAwareRetrieval.js';
import { Vector } from '../../src/core/types.js';

function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

describe('parseNegation', () => {
  it('returns no negation for plain queries', () => {
    const parsed = parseNegation('recipes with cilantro and lime');
    expect(parsed.hasNegation).toBe(false);
    expect(parsed.negatedPhrases).toEqual([]);
  });

  it('extracts the negated concept after "without"', () => {
    const parsed = parseNegation('recipes without cilantro');
    expect(parsed.hasNegation).toBe(true);
    expect(parsed.negatedPhrases).toEqual(['cilantro']);
    expect(parsed.positive).toBe('recipes');
  });

  it('strips a leading auxiliary after a contraction', () => {
    const parsed = parseNegation("notes where I doesn't like cilantro");
    expect(parsed.negatedPhrases).toEqual(['cilantro']);
  });

  it('stops the negated scope at a conjunction', () => {
    const parsed = parseNegation('places not noisy but cheap');
    expect(parsed.negatedPhrases).toEqual(['noisy']);
    expect(parsed.positive).toContain('cheap');
  });
});

describe('orthogonalNegation', () => {
  it('removes the component along a single negated direction', () => {
    const query: Vector = [1, 1, 0];
    const negated: Vector = [0, 1, 0];
    const result = orthogonalNegation(query, [negated]);
    // Component along the negated axis is gone.
    expect(result[1]).toBeCloseTo(0, 10);
    expect(result[0]).toBeCloseTo(1, 10);
  });

  it('is a no-op when there is nothing to negate', () => {
    const query: Vector = [0.3, -0.7, 0.5];
    expect(orthogonalNegation(query, [])).toEqual(query);
  });

  it('ignores near-zero negated vectors', () => {
    const query: Vector = [1, 2, 3];
    expect(orthogonalNegation(query, [[0, 0, 0]])).toEqual(query);
  });

  it('handles overlapping negated directions without over-subtracting', () => {
    const query: Vector = [1, 1, 1];
    // Two collinear negated directions should remove the axis exactly once.
    const result = orthogonalNegation(query, [[0, 1, 0], [0, 2, 0]]);
    expect(result[1]).toBeCloseTo(0, 10);
    expect(result[0]).toBeCloseTo(1, 10);
    expect(result[2]).toBeCloseTo(1, 10);
  });
});

describe('buildNegationAwareQueryVector', () => {
  // Toy embedding: orthogonal basis directions per concept.
  const space: Record<string, Vector> = {
    recipes: [1, 0, 0],
    cilantro: [0, 1, 0],
    lime: [0, 0, 1],
  };
  const embed = async (text: string): Promise<Vector> => {
    const v: Vector = [0, 0, 0];
    for (const word of text.toLowerCase().split(/\s+/).filter(Boolean)) {
      const base = space[word];
      if (base) {
        for (let i = 0; i < v.length; i++) v[i] += base[i];
      }
    }
    return v;
  };

  it('returns a plain embedding when there is no negation', async () => {
    const v = await buildNegationAwareQueryVector('recipes with lime', embed);
    expect(v).toEqual(await embed('recipes with lime'));
  });

  it('pushes the query away from the negated concept', async () => {
    const negationAware = await buildNegationAwareQueryVector('recipes without cilantro', embed);
    const naive = await embed('recipes without cilantro');

    const cilantro = space.cilantro;
    // Naive embedding still has cilantro in it; the negation-aware one does not.
    expect(cosine(naive, cilantro)).toBeGreaterThan(0.1);
    expect(cosine(negationAware, cilantro)).toBeCloseTo(0, 6);
    // ...while staying aligned with the positive concept.
    expect(cosine(negationAware, space.recipes)).toBeGreaterThan(0.9);
  });
});
