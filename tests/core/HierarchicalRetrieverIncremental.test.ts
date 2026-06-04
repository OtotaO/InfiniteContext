import { HierarchicalRetriever } from '../../src/core/HierarchicalRetriever.js';
import { Chunk } from '../../src/core/types.js';

const DIM = 12;

// Fresh chunk each call (both rebuild and addChunk mutate metadata/hierarchy, so
// the two retrievers under comparison must not share chunk objects).
function makeChunk(i: number): Chunk {
  const embedding = Array(DIM).fill(0);
  embedding[i % DIM] = 1;
  embedding[(i * 5 + 1) % DIM] += 0.4; // a little variety so scores are distinct
  return {
    id: `c${i}`,
    content: `content ${i}`,
    embedding,
    metadata: {
      id: `c${i}`,
      timestamp: new Date().toISOString(),
      domain: i % 2 === 0 ? 'd0' : 'd1',
      source: `trace${i % 3}`,
      tags: [`cat${i % 4}`],
    },
    summaries: [],
  } as unknown as Chunk;
}

function ids(results: { chunk: Chunk }[]): string[] {
  return results.map(r => r.chunk.id);
}

describe('HierarchicalRetriever incremental addChunk', () => {
  const n = 12;

  it('produces identical results to a full rebuild (exact mode)', () => {
    const full = new HierarchicalRetriever(
      Array.from({ length: n }, (_, i) => makeChunk(i)),
      { annThreshold: 1000 },
    );

    const incremental = new HierarchicalRetriever([], { annThreshold: 1000 });
    for (let i = 0; i < n; i++) {
      expect(incremental.addChunk(makeChunk(i))).toBe(true);
    }

    for (const axis of [0, 3, 7, 11]) {
      const query = Array(DIM).fill(0);
      query[axis] = 1;

      // Routed hierarchical search and flat search must match exactly.
      expect(ids(incremental.search(query, { finalK: 6 }).results))
        .toEqual(ids(full.search(query, { finalK: 6 }).results));
      expect(ids(incremental.flatSearch(query, 6).results))
        .toEqual(ids(full.flatSearch(query, 6).results));
    }
  });

  it('signals a needed rebuild when an append would cross the ANN threshold', () => {
    const retriever = new HierarchicalRetriever([], { annThreshold: 4 });
    // First three appends are absorbed incrementally...
    expect(retriever.addChunk(makeChunk(0))).toBe(true);
    expect(retriever.addChunk(makeChunk(1))).toBe(true);
    expect(retriever.addChunk(makeChunk(2))).toBe(true);
    // ...the fourth would require creating the global ANN graph, so defer.
    expect(retriever.addChunk(makeChunk(3))).toBe(false);
  });

  it('keeps an existing ANN graph in sync across incremental appends', async () => {
    // Build a retriever over a large single trace so the ANN graphs exist...
    const base = Array.from({ length: 8 }, (_, i) => {
      const c = makeChunk(i);
      (c.metadata as any).domain = 'd';
      (c.metadata as any).source = 'one-trace';
      (c.metadata as any).tags = ['cat'];
      return c;
    });
    const retriever = new HierarchicalRetriever(base, { annThreshold: 4 });
    await retriever.ready();
    expect(retriever.usesApproximateEpisodeIndex()).toBe(true);

    // ...then append more episodes into the same (existing) graphs.
    for (let i = 8; i < 12; i++) {
      const c = makeChunk(i);
      (c.metadata as any).domain = 'd';
      (c.metadata as any).source = 'one-trace';
      (c.metadata as any).tags = ['cat'];
      expect(retriever.addChunk(c)).toBe(true);
    }

    // A query matching one of the appended episodes should retrieve it.
    const target = Array(DIM).fill(0);
    target[10 % DIM] = 1;
    target[(10 * 5 + 1) % DIM] = 0.4;
    const hit = retriever.flatSearch(target, 3).results[0];
    expect(hit.chunk.id).toBe('c10');
  });
});
