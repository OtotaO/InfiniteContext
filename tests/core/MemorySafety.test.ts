import { DeletionStatus, RetentionPolicy, SensitivityLevel, UserProfileMemory } from '../../src/core/types.js';
import { MemoryManager } from '../../src/core/MemoryManager.js';

const embeddingFunction = async (text: string) => [text.length || 1, 1, 0];

function buildProfile(userId: string): UserProfileMemory {
  const now = new Date().toISOString();
  return {
    id: `profile-${userId}`,
    userId,
    preferences: [],
    interests: [],
    emotionalState: [
      {
        id: 'field-1',
        category: 'emotionalState',
        key: 'mood',
        value: 'anxious about deadlines',
        confidence: 0.9,
        sourceEpisodeIds: ['ep1'],
        traceIds: ['tr1'],
        createdAt: now,
        updatedAt: now,
        lastObservedAt: now,
      },
    ],
    behavioralPatterns: [],
    sourceEpisodeIds: ['ep1'],
    traceIds: ['tr1'],
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
    lastObservedAt: now,
  };
}

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

    await manager.shutdown();
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

    await manager.shutdown();
  });

  it('governs extracted user profiles through the unified safety pipeline', async () => {
    const manager = new MemoryManager({ embeddingFunction });
    await manager.storeUserProfileMemory(buildProfile('u1'));
    await manager.storeUserProfileMemory(buildProfile('u2'));

    // Right-to-access: an export scoped to the user includes their inferred profile.
    const exported = manager.exportMemories({ userId: 'u1' });
    expect(exported.userProfiles).toHaveLength(1);
    expect(exported.userProfiles[0].emotionalState[0].value).toBe('anxious about deadlines');

    // Facet-scoped queries must NOT over-match profiles (profiles have no
    // domain/tag/sensitivity), preserving targeted redaction semantics.
    expect(manager.redactMemories({ userId: 'u1', sensitivity: SensitivityLevel.RESTRICTED }, 'x'))
      .toEqual({ matched: 0, changed: 0 });

    // Right-to-erasure: a user-scoped deletion reaches the inferred profile too.
    expect(manager.deleteMemories({ userId: 'u1' }, 'user request')).toEqual({ matched: 1, changed: 1 });
    expect(manager.getUserProfileMemories('u1')).toHaveLength(0);
    expect(manager.getUserProfileMemories('u2')).toHaveLength(1);

    // The tombstone is retained and value redacted for auditability.
    const tombstone = manager.listMemories({ userId: 'u1', includeDeleted: true }).userProfiles[0];
    expect(tombstone.deletionStatus).toBe(DeletionStatus.DELETED);
    expect(tombstone.emotionalState[0].value).toBe('[REDACTED]');

    await manager.shutdown();
  });
});
