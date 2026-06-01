import { HierarchicalRetriever } from '../../src/core/HierarchicalRetriever.js';
import { Chunk } from '../../src/core/types.js';

// Minimal chunk with a one-hot embedding at `axis` (dimension `dim`).
function oneHotChunk(id: string, axis: number, dim: number): Chunk {
  const embedding = Array(dim).fill(0);
  embedding[axis] = 1;
  return {
    id,
    content: `chunk ${id}`,
    embedding,
    metadata: {
      id,
      timestamp: new Date().toISOString(),
      domain: 'test',
      source: 'test',
      tags: [],
    },
    summaries: [],
  } as unknown as Chunk;
}

describe('HierarchicalRetriever approximate episode index', () => {
  const dim = 12;
  const chunks = Array.from({ length: dim }, (_, i) => oneHotChunk(`c${i}`, i, dim));

  it('activates the HNSW index once the episode count crosses the threshold', async () => {
    const exact = new HierarchicalRetriever(chunks, { annThreshold: 1000 });
    await exact.ready();
    expect(exact.usesApproximateEpisodeIndex()).toBe(false);

    const approx = new HierarchicalRetriever(chunks, { annThreshold: 4 });
    await approx.ready();
    expect(approx.usesApproximateEpisodeIndex()).toBe(true);
  });

  it('returns the same top hit as the exact scan for well-separated vectors', async () => {
    const exact = new HierarchicalRetriever(chunks, { annThreshold: 1000 });
    const approx = new HierarchicalRetriever(chunks, { annThreshold: 4 });
    await approx.ready();
    expect(approx.usesApproximateEpisodeIndex()).toBe(true);

    for (const axis of [0, 5, 11]) {
      const query = Array(dim).fill(0);
      query[axis] = 1;

      const exactTop = exact.flatSearch(query, 3).results[0];
      const approxResponse = approx.flatSearch(query, 3);

      expect(approxResponse.results[0].chunk.id).toBe(`c${axis}`);
      expect(approxResponse.results[0].chunk.id).toBe(exactTop.chunk.id);
      // cosine of a one-hot vector with itself is 1.
      expect(approxResponse.results[0].score).toBeCloseTo(1, 5);
    }
  });

  it('falls back to an exact scan when the query dimension does not match', async () => {
    const approx = new HierarchicalRetriever(chunks, { annThreshold: 4 });
    await approx.ready();
    // Wrong-dimension query must not throw; it degrades to the exact path.
    expect(() => approx.flatSearch([1, 0, 0], 3)).not.toThrow();
  });
});
