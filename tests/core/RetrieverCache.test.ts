import { MemoryManager } from '../../src/core/MemoryManager.js';

// Deterministic 3-D embedding keyed on a few marker words.
const embeddingFunction = async (text: string): Promise<number[]> => {
  const t = text.toLowerCase();
  if (t.includes('apple')) return [1, 0, 0];
  if (t.includes('banana')) return [0, 1, 0];
  return [0, 0, 1];
};

describe('cached hierarchical retriever', () => {
  it('rebuilds when new chunks are added so results stay fresh', async () => {
    const manager = new MemoryManager({ embeddingFunction });
    const bucket = manager.createBucket({ name: 'fruit', domain: 'food' });

    const apple = await manager.createChunk('apple pie', { domain: 'food', source: 'test', tags: ['fruit'] });
    bucket.addChunk(apple);

    // First query warms the cache.
    const first = await manager.searchMemory('apple', { mode: 'flat', k: 5 });
    expect(first.results.map(r => r.chunk.id)).toEqual([apple.id]);

    // Adding a chunk must invalidate the cache; the new chunk has to appear.
    const banana = await manager.createChunk('banana bread', { domain: 'food', source: 'test', tags: ['fruit'] });
    bucket.addChunk(banana);

    const second = await manager.searchMemory('banana', { mode: 'flat', k: 5 });
    expect(second.results[0].chunk.id).toBe(banana.id);
    expect(second.results.map(r => r.chunk.id)).toContain(apple.id);

    await manager.shutdown();
  });
});
