import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MemoryManager } from '../../src/core/MemoryManager.js';
import { DeletionStatus } from '../../src/core/types.js';
import { REDACTED_TEXT } from '../../src/utils/MemorySafety.js';

const embeddingFunction = async (text: string): Promise<number[]> => [text.length || 1, 1, 0];

async function withTempBase<T>(fn: (basePath: string) => Promise<T>): Promise<T> {
  const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-erasure-'));
  try {
    return await fn(basePath);
  } finally {
    await fs.rm(basePath, { recursive: true, force: true });
  }
}

/** Read every stored blob (excluding .meta sidecars) as raw text. */
async function readAllBlobs(basePath: string): Promise<string> {
  const storageDir = path.join(basePath, 'storage');
  let names: string[] = [];
  try {
    names = await fs.readdir(storageDir);
  } catch {
    return '';
  }
  const blobs = await Promise.all(
    names
      .filter(name => !name.endsWith('.meta'))
      .map(name => fs.readFile(path.join(storageDir, name), 'utf-8').catch(() => '')),
  );
  return blobs.join('\n');
}

describe('durable erasure', () => {
  it('redaction removes original content from disk and does not resurrect on restart', async () => {
    await withTempBase(async basePath => {
      const secret = 'TOP-SECRET-PASSPHRASE-correct-horse-battery-staple';

      const first = new MemoryManager({ basePath, embeddingFunction });
      await first.initialize({ localStoragePath: path.join(basePath, 'storage') });
      const bucket = first.createBucket({ name: 'notes', domain: 'personal' });
      const chunk = await first.createChunk(secret, { domain: 'personal', source: 'test', tags: ['pii'] });
      bucket.addChunk(chunk);
      await first.storeChunk(chunk);

      // Sanity: the secret is on disk before redaction.
      expect(await readAllBlobs(basePath)).toContain(secret);

      const result = first.redactMemories({ tags: ['pii'] }, 'user request');
      expect(result.changed).toBe(1);
      await first.shutdown();

      // The original content must be gone from every stored blob...
      const blobsAfter = await readAllBlobs(basePath);
      expect(blobsAfter).not.toContain(secret);
      expect(blobsAfter).toContain(REDACTED_TEXT);

      // ...and a fresh manager (restart) must not bring it back.
      const second = new MemoryManager({ basePath, embeddingFunction });
      await second.initialize({ localStoragePath: path.join(basePath, 'storage') });
      const listed = second.listMemories({ domain: 'personal', includeDeleted: true });
      const restored = listed.chunks.find(c => c.id === chunk.id);
      expect(restored?.content).toBe(REDACTED_TEXT);
      expect(restored?.metadata.deletionStatus).toBe(DeletionStatus.REDACTED);
      await second.shutdown();
    });
  });

  it('deletion persists the tombstone across restart and the original cannot be read by id', async () => {
    await withTempBase(async basePath => {
      const secret = 'DELETE-ME-sensitive-account-number-1234';

      const first = new MemoryManager({ basePath, embeddingFunction });
      await first.initialize({ localStoragePath: path.join(basePath, 'storage') });
      const bucket = first.createBucket({ name: 'notes', domain: 'personal' });
      const chunk = await first.createChunk(secret, { domain: 'personal', source: 'test', tags: ['pii'] });
      bucket.addChunk(chunk);
      await first.storeChunk(chunk);

      first.deleteMemories({ tags: ['pii'] }, 'erasure');
      await first.shutdown();

      expect(await readAllBlobs(basePath)).not.toContain(secret);

      const second = new MemoryManager({ basePath, embeddingFunction });
      await second.initialize({ localStoragePath: path.join(basePath, 'storage') });
      // A deleted chunk is no longer a valid read target by id.
      await expect(second.retrieveChunk(chunk.id)).rejects.toThrow(/not retrievable/);
      const listed = second.listMemories({ domain: 'personal', includeDeleted: true });
      expect(listed.chunks.find(c => c.id === chunk.id)?.metadata.deletionStatus).toBe(DeletionStatus.DELETED);
      await second.shutdown();
    });
  });

  it('a redacted chunk does not break subsequent retrieval', async () => {
    await withTempBase(async basePath => {
      const manager = new MemoryManager({ basePath, embeddingFunction });
      await manager.initialize({ localStoragePath: path.join(basePath, 'storage') });
      const bucket = manager.createBucket({ name: 'notes', domain: 'work' });

      const keep = await manager.createChunk('quarterly revenue projections', { domain: 'work', source: 'test', tags: ['keep'] });
      const drop = await manager.createChunk('private salary details', { domain: 'work', source: 'test', tags: ['pii'] });
      bucket.addChunks([keep, drop]);

      manager.redactMemories({ tags: ['pii'] }, 'user request');

      // Before the fix this threw "Vectors must have the same dimension".
      const results = bucket.search(await embeddingFunction('revenue'), 10);
      expect(results.map(r => r.chunk.id)).toContain(keep.id);
      expect(results.map(r => r.chunk.id)).not.toContain(drop.id);

      await manager.shutdown();
    });
  });
});
