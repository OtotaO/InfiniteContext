import { describe, expect, it, beforeEach } from '@jest/globals';
import { VectorStore } from '../../src/core/VectorStore.js';
import { Chunk } from '../../src/core/types.js';
import { indexManager, IndexType } from '../../src/utils/IndexManager.js';
import { v4 as uuidv4 } from 'uuid';
import { mkdtemp, readFile, stat, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('VectorStore', () => {
  let vectorStore: VectorStore;
  const dimension = 5; // Small dimension for testing

  beforeEach(() => {
    vectorStore = new VectorStore(dimension);
  });

  describe('initialization', () => {
    it('should create a new VectorStore with the specified dimension', () => {
      expect(vectorStore).toBeDefined();
      expect(vectorStore.size()).toBe(0);
    });

    it('should support different distance metrics', () => {
      const cosineStore = new VectorStore(dimension, 'cosine');
      const euclideanStore = new VectorStore(dimension, 'euclidean');
      const dotStore = new VectorStore(dimension, 'dot');

      expect(cosineStore).toBeDefined();
      expect(euclideanStore).toBeDefined();
      expect(dotStore).toBeDefined();
    });
  });

  describe('addChunk', () => {
    it('should add a chunk to the store', () => {
      const chunk = createTestChunk(dimension);
      const index = vectorStore.addChunk(chunk);

      expect(index).toBe(0);
      expect(vectorStore.size()).toBe(1);
    });

    it('should add multiple chunks to the store', () => {
      const chunks = [
        createTestChunk(dimension),
        createTestChunk(dimension),
        createTestChunk(dimension),
      ];

      const indices = vectorStore.addChunks(chunks);

      expect(indices).toEqual([0, 1, 2]);
      expect(vectorStore.size()).toBe(3);
    });

    it('should throw an error if chunk embedding dimension does not match store dimension', () => {
      const wrongDimensionChunk = createTestChunk(dimension + 1);

      expect(() => {
        vectorStore.addChunk(wrongDimensionChunk);
      }).toThrow();
    });
  });

  describe('search', () => {
    beforeEach(() => {
      // Add some test chunks with known embeddings
      const chunk1 = createTestChunk(dimension, [1, 0, 0, 0, 0]);
      const chunk2 = createTestChunk(dimension, [0, 1, 0, 0, 0]);
      const chunk3 = createTestChunk(dimension, [0, 0, 1, 0, 0]);

      vectorStore.addChunks([chunk1, chunk2, chunk3]);
    });

    it('should find the most similar chunks using cosine similarity', () => {
      const queryVector = [1, 0.1, 0.1, 0, 0]; // Most similar to first chunk
      const results = vectorStore.search(queryVector, 2);

      expect(results.length).toBe(2);
      expect(results[0].score).toBeGreaterThan(0.9); // High similarity to first chunk
      expect(results[0].chunk.embedding).toEqual([1, 0, 0, 0, 0]);
    });

    it('should limit results to k', () => {
      const queryVector = [0.33, 0.33, 0.33, 0, 0]; // Equally similar to first three chunks
      const results = vectorStore.search(queryVector, 2);

      expect(results.length).toBe(2);
    });

    it('should handle empty store gracefully', () => {
      const emptyStore = new VectorStore(dimension);
      const queryVector = [1, 0, 0, 0, 0];
      const results = emptyStore.search(queryVector);

      expect(results.length).toBe(0);
    });
  });

  describe('persistence and flat index artifacts', () => {
    it('should save a chunk payload and a real flat index artifact', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'vector-store-'));
      const savePath = join(tempDir, 'store');
      const chunks = [
        createTestChunk(dimension, [1, 0, 0, 0, 0]),
        createTestChunk(dimension, [0, 1, 0, 0, 0]),
      ];

      vectorStore.addChunks(chunks);
      await vectorStore.save(savePath);

      const chunkFile = JSON.parse(await readFile(`${savePath}.json`, 'utf-8'));
      const indexFile = JSON.parse(await readFile(`${savePath}.index.json`, 'utf-8'));

      expect(chunkFile).toHaveLength(2);
      expect(indexFile.backend).toBe(IndexType.FLAT);
      expect(indexFile.size).toBe(2);
      expect(indexFile.entries.map((entry: { id: string }) => entry.id)).toEqual(chunks.map(chunk => chunk.id));
      expect((await stat(`${savePath}.index.json`)).size).toBeGreaterThan(0);
    });

    it('should rebuild a missing flat index artifact during load', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'vector-store-load-'));
      const savePath = join(tempDir, 'store');
      vectorStore.addChunk(createTestChunk(dimension, [1, 0, 0, 0, 0]));
      await vectorStore.save(savePath);

      const indexPath = `${savePath}.index.json`;
      const before = JSON.parse(await readFile(indexPath, 'utf-8'));
      await unlink(indexPath);

      const loadedStore = new VectorStore(dimension, 'cosine');
      await loadedStore.load(savePath);
      const after = JSON.parse(await readFile(indexPath, 'utf-8'));

      expect(loadedStore.size()).toBe(1);
      expect(after.size).toBe(before.size);
      expect(after.entries).toEqual(before.entries);
    });
  });

  describe('IndexManager flat index operations', () => {
    it('should rebuild, merge, and split persisted index artifacts', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'index-manager-'));
      const params = { type: IndexType.FLAT, dimension, metric: 'cosine' as const };
      const firstIndex = join(tempDir, 'first.flat-index.json');
      const secondIndex = join(tempDir, 'second.flat-index.json');
      const mergedIndex = join(tempDir, 'merged.flat-index.json');
      const shardDir = join(tempDir, 'shards');
      const firstChunks = [
        createTestChunk(dimension, [1, 0, 0, 0, 0]),
        createTestChunk(dimension, [0, 1, 0, 0, 0]),
      ];
      const secondChunks = [createTestChunk(dimension, [0, 0, 1, 0, 0])];

      await expect(indexManager.rebuildIndex(firstChunks, params, firstIndex)).resolves.toBe(true);
      await expect(indexManager.rebuildIndex(secondChunks, params, secondIndex)).resolves.toBe(true);

      const firstArtifact = JSON.parse(await readFile(firstIndex, 'utf-8'));
      const secondArtifact = JSON.parse(await readFile(secondIndex, 'utf-8'));
      expect(firstArtifact.size).toBe(2);
      expect(secondArtifact.size).toBe(1);
      expect(firstArtifact.entries).toHaveLength(2);
      expect(secondArtifact.entries).toHaveLength(1);

      await expect(indexManager.mergeIndices([firstIndex, secondIndex], mergedIndex, params)).resolves.toBe(true);
      const mergedArtifact = JSON.parse(await readFile(mergedIndex, 'utf-8'));
      expect(mergedArtifact.size).toBe(3);
      expect(mergedArtifact.entries.map((entry: { id: string }) => entry.id)).toEqual([
        ...firstChunks.map(chunk => chunk.id),
        ...secondChunks.map(chunk => chunk.id),
      ]);

      await expect(indexManager.splitIndex(mergedIndex, shardDir, 2, params)).resolves.toBe(true);
      const firstShard = JSON.parse(await readFile(join(shardDir, 'shard-0.flat-index.json'), 'utf-8'));
      const secondShard = JSON.parse(await readFile(join(shardDir, 'shard-1.flat-index.json'), 'utf-8'));
      expect(firstShard.size + secondShard.size).toBe(mergedArtifact.size);
      expect(firstShard.entries).toHaveLength(2);
      expect(secondShard.entries).toHaveLength(1);
    });

    it('should reject approximate index operations instead of returning fake success', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'index-manager-unsupported-'));
      const unsupportedParams = { type: IndexType.HNSW, dimension, metric: 'cosine' as const };
      const outputPath = join(tempDir, 'hnsw-index.json');

      await expect(indexManager.rebuildIndex([createTestChunk(dimension)], unsupportedParams, outputPath)).resolves.toBe(false);

      await expect(readFile(outputPath, 'utf-8')).rejects.toThrow();
    });
  });

  // Helper function to create test chunks
  function createTestChunk(dim: number, embedding?: number[]): Chunk {
    return {
      id: uuidv4(),
      content: 'Test content',
      embedding: embedding || Array(dim).fill(0).map(() => Math.random()),
      metadata: {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        domain: 'test',
        source: 'test',
        tags: ['test'],
      },
      summaries: [],
    };
  }
});
