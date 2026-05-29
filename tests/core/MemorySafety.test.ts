import { DeletionStatus, RetentionPolicy, SensitivityLevel } from '../../src/core/types.js';
import { MemoryManager } from '../../src/core/MemoryManager.js';

const embeddingFunction = async (text: string) => [text.length || 1, 1, 0];

describe('long-term memory safety controls', () => {
  it('filters expired and deleted chunks from retrieval-facing searches', async () => {
    const manager = new MemoryManager({ embeddingFunction });
    const bucket = manager.createBucket({ name: 'general', domain: 'work' });
    const active = await manager.createChunk('active memory', { domain: 'work', source: 'test', tags: ['safe'] });
    const expired = await manager.createChunk('expired memory', {
      domain: 'work',
      source: 'test',
      tags: ['safe'],
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const deleted = await manager.createChunk('deleted memory', {
      domain: 'work',
      source: 'test',
      tags: ['safe'],
      deletionStatus: DeletionStatus.DELETED,
    });

    bucket.addChunks([active, expired, deleted]);

    const listed = manager.listMemories({ domain: 'work' });
    expect(listed.chunks.map(chunk => chunk.id)).toEqual([active.id]);
  });

  it('redacts, exports, and deletes memories by query filters', async () => {
    const manager = new MemoryManager({ embeddingFunction });
    const bucket = manager.createBucket({ name: 'profile', domain: 'personal' });
    const chunk = await manager.createChunk('secret memory', {
      userId: 'u1',
      domain: 'personal',
      source: 'test',
      tags: ['pii'],
      retentionPolicy: RetentionPolicy.STANDARD,
      sensitivity: SensitivityLevel.RESTRICTED,
    });
    bucket.addChunk(chunk);
    manager.upsertProfileMemory({
      userId: 'u1',
      domain: 'personal',
      bucket: 'profile',
      key: 'favorite_color',
      value: 'blue',
      tags: ['pii'],
      sensitivity: SensitivityLevel.RESTRICTED,
    });

    expect(manager.redactMemories({ userId: 'u1', tag: 'pii' }, 'user request')).toEqual({ matched: 2, changed: 2 });
    const exported = manager.exportMemories({ userId: 'u1', includeDeleted: true });
    expect(exported.chunks[0].content).toBe('[REDACTED]');
    expect(exported.profileMemories[0].value).toBe('[REDACTED]');

    expect(manager.deleteMemories({ sensitivity: SensitivityLevel.RESTRICTED }, 'retention')).toEqual({ matched: 2, changed: 2 });
    expect(manager.listMemories({ userId: 'u1' }).chunks).toHaveLength(0);
    expect(manager.listMemories({ userId: 'u1', includeDeleted: true }).chunks[0].metadata.deletionStatus).toBe(DeletionStatus.DELETED);
  });
});
