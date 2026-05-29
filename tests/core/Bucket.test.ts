import { describe, expect, it } from '@jest/globals';
import { Bucket } from '../../src/core/Bucket.js';
import { Chunk } from '../../src/core/types.js';

const embeddingDimension = 1536;

describe('Bucket', () => {
  describe('getAllChunks', () => {
    it('should return multiple chunks from the bucket and recursive sub-buckets', () => {
      const bucket = createTestBucket('root', 'root-domain');
      const rootChunks = [
        createTestChunk('root-1', createEmbedding(0)),
        createTestChunk('root-2', createEmbedding(1)),
      ];
      bucket.addChunks(rootChunks);

      const subBucket = bucket.addSubBucket({
        id: 'sub',
        name: 'Sub Bucket',
        domain: 'sub-domain',
      });
      subBucket.addChunks([
        createTestChunk('sub-1', createEmbedding(2)),
        createTestChunk('sub-2', createEmbedding(3)),
      ]);

      const chunks = bucket.getAllChunks();

      expect(chunks).toHaveLength(4);
      expect(chunks.map(chunk => chunk.id)).toEqual([
        'root-1',
        'root-2',
        'sub-1',
        'sub-2',
      ]);
      expect(chunks.map(chunk => chunk.metadata.domain)).toEqual([
        'root-domain',
        'root-domain',
        'sub-domain',
        'sub-domain',
      ]);
    });

    it('should exclude sub-bucket chunks when recursive is false', () => {
      const bucket = createTestBucket('root', 'root-domain');
      bucket.addChunk(createTestChunk('root-1', createEmbedding(0)));

      const subBucket = bucket.addSubBucket({
        id: 'sub',
        name: 'Sub Bucket',
        domain: 'sub-domain',
      });
      subBucket.addChunk(createTestChunk('sub-1', createEmbedding(1)));

      const chunks = bucket.getAllChunks(false);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].id).toBe('root-1');
    });

    it('should return defensive copies of chunks', () => {
      const bucket = createTestBucket('root', 'root-domain');
      bucket.addChunk(createTestChunk('root-1', createEmbedding(0)));

      const [chunk] = bucket.getAllChunks();
      chunk.content = 'mutated';
      chunk.embedding[0] = 0;
      chunk.metadata.domain = 'mutated-domain';
      chunk.metadata.tags.push('mutated-tag');
      chunk.summaries[0].content = 'mutated summary';
      chunk.summaries[0].concepts.push('mutated-concept');

      const [freshChunk] = bucket.getAllChunks();

      expect(freshChunk.content).toBe('Content for root-1');
      expect(freshChunk.embedding[0]).toBe(1);
      expect(freshChunk.embedding.slice(1)).toEqual(
        Array(embeddingDimension - 1).fill(0)
      );
      expect(freshChunk.metadata.domain).toBe('root-domain');
      expect(freshChunk.metadata.tags).toEqual(['test']);
      expect(freshChunk.summaries[0].content).toBe('Summary for root-1');
      expect(freshChunk.summaries[0].concepts).toEqual(['root-1']);
    });
  });
});

function createTestBucket(id: string, domain: string): Bucket {
  return new Bucket({
    id,
    name: `${id} Bucket`,
    domain,
  });
}

function createTestChunk(id: string, embedding: number[]): Chunk {
  return {
    id,
    content: `Content for ${id}`,
    embedding,
    metadata: {
      id: `${id}-metadata`,
      timestamp: new Date('2026-05-28T00:00:00.000Z').toISOString(),
      domain: 'original-domain',
      source: 'test',
      tags: ['test'],
    },
    summaries: [
      {
        level: 1,
        content: `Summary for ${id}`,
        concepts: [id],
      },
    ],
  };
}

function createEmbedding(oneIndex: number): number[] {
  const embedding = Array(embeddingDimension).fill(0);
  embedding[oneIndex] = 1;
  return embedding;
}
