import { describe, expect, it } from '@jest/globals';
import { HierarchicalRetriever } from '../../src/core/HierarchicalRetriever.js';
import { Chunk, HierarchyLevel } from '../../src/core/types.js';

function chunk(id: string, embedding: number[], domain: string, category: string, trace: string): Chunk {
  return {
    id,
    content: `${domain} ${category} ${trace} episode ${id}`,
    embedding,
    metadata: {
      id: `${id}-metadata`,
      timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      domain,
      category,
      memoryTraceId: trace,
      source: trace,
      tags: [category]
    },
    summaries: []
  };
}

describe('HierarchicalRetriever', () => {
  it('stores positional child pointers and vectors at every hierarchy level', () => {
    const chunks = [
      chunk('ep-1', [1, 0, 0], 'engineering', 'api', 'trace-a'),
      chunk('ep-2', [0.9, 0.1, 0], 'engineering', 'api', 'trace-a')
    ];

    const retriever = new HierarchicalRetriever(chunks);
    const response = retriever.search([1, 0, 0], {
      domainK: 1,
      categoryK: 1,
      traceK: 1,
      episodeK: 2,
      finalK: 2
    });

    expect(response.results).toHaveLength(2);
    expect(response.results[0].path.map(step => step.level)).toEqual([
      HierarchyLevel.DOMAIN,
      HierarchyLevel.CATEGORY,
      HierarchyLevel.MEMORY_TRACE,
      HierarchyLevel.EPISODE
    ]);
    expect(response.results[0].chunk.hierarchy?.parentId).toContain('memoryTrace:engineering/api/trace-a');
    expect(response.stats.candidatesByLevel[HierarchyLevel.DOMAIN]).toBe(1);
    expect(response.stats.candidatesByLevel[HierarchyLevel.CATEGORY]).toBe(1);
    expect(response.stats.candidatesByLevel[HierarchyLevel.MEMORY_TRACE]).toBe(1);
  });

  it('benchmarks fewer routed candidates than flat recursive search', () => {
    const chunks: Chunk[] = [];
    const domains = [
      { name: 'engineering', base: [1, 0, 0] },
      { name: 'design', base: [0, 1, 0] },
      { name: 'finance', base: [0, 0, 1] }
    ];

    for (const domain of domains) {
      for (let category = 0; category < 3; category++) {
        for (let trace = 0; trace < 3; trace++) {
          for (let episode = 0; episode < 3; episode++) {
            chunks.push(chunk(
              `${domain.name}-${category}-${trace}-${episode}`,
              domain.base,
              domain.name,
              `category-${category}`,
              `trace-${trace}`
            ));
          }
        }
      }
    }

    const retriever = new HierarchicalRetriever(chunks);
    const flat = retriever.flatSearch([1, 0, 0], 5);
    const routed = retriever.search([1, 0, 0], {
      domainK: 1,
      categoryK: 1,
      traceK: 1,
      episodeK: 3,
      finalK: 5
    });

    expect(flat.stats.flatCandidateCount).toBe(81);
    expect(routed.stats.flatCandidateCount).toBe(81);
    expect(routed.stats.routedCandidateCount).toBeLessThan(flat.stats.flatCandidateCount);
    expect(routed.stats.candidatesByLevel).toEqual({
      [HierarchyLevel.DOMAIN]: 3,
      [HierarchyLevel.CATEGORY]: 3,
      [HierarchyLevel.MEMORY_TRACE]: 3,
      [HierarchyLevel.EPISODE]: 3
    });
  });
});
