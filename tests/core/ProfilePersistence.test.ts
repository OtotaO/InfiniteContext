import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MemoryManager } from '../../src/core/MemoryManager.js';
import { DeletionStatus, UserProfileMemory } from '../../src/core/types.js';

const embeddingFunction = async (text: string) => [text.length || 1, 1, 0];

function buildProfile(userId: string): UserProfileMemory {
  const now = new Date().toISOString();
  return {
    id: `profile-${userId}`,
    userId,
    preferences: [
      {
        id: 'pref-1',
        category: 'preferences',
        key: 'coffee',
        value: 'espresso',
        confidence: 0.8,
        sourceEpisodeIds: ['ep1'],
        traceIds: ['tr1'],
        createdAt: now,
        updatedAt: now,
        lastObservedAt: now,
      },
    ],
    interests: [],
    emotionalState: [],
    behavioralPatterns: [],
    sourceEpisodeIds: ['ep1'],
    traceIds: ['tr1'],
    confidence: 0.8,
    createdAt: now,
    updatedAt: now,
    lastObservedAt: now,
  };
}

describe('profile memory persistence', () => {
  it('restores manual and extracted profile memories across manager restarts', async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-profile-'));
    const localStoragePath = path.join(basePath, 'storage');

    try {
      const first = new MemoryManager({ basePath, embeddingFunction });
      await first.initialize({ localStoragePath });

      first.upsertProfileMemory({
        userId: 'u1',
        domain: 'work',
        key: 'favorite_color',
        value: 'blue',
        tags: ['pref'],
      });
      await first.storeUserProfileMemory(buildProfile('u1'));

      // shutdown() drains the background manifest-write queue.
      await first.shutdown();

      // A fresh manager on the same basePath should rehydrate both maps.
      const second = new MemoryManager({ basePath, embeddingFunction });
      await second.initialize({ localStoragePath });

      const kvFacts = second.listMemories({ userId: 'u1' }).profileMemories;
      expect(kvFacts).toHaveLength(1);
      expect(kvFacts[0].key).toBe('favorite_color');
      expect(kvFacts[0].value).toBe('blue');

      const profiles = second.getUserProfileMemories('u1');
      expect(profiles).toHaveLength(1);
      expect(profiles[0].preferences[0].value).toBe('espresso');

      await second.shutdown();
    } finally {
      await fs.rm(basePath, { recursive: true, force: true });
    }
  });

  it('persists redaction tombstones so erasure survives a restart', async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-profile-'));
    const localStoragePath = path.join(basePath, 'storage');

    try {
      const first = new MemoryManager({ basePath, embeddingFunction });
      await first.initialize({ localStoragePath });
      await first.storeUserProfileMemory(buildProfile('u1'));
      first.deleteMemories({ userId: 'u1' }, 'user request');
      await first.shutdown();

      const second = new MemoryManager({ basePath, embeddingFunction });
      await second.initialize({ localStoragePath });

      // The deleted profile must not resurface in normal reads...
      expect(second.getUserProfileMemories('u1')).toHaveLength(0);
      // ...but the redacted tombstone is retained for auditability.
      const tombstone = second.listMemories({ userId: 'u1', includeDeleted: true }).userProfiles[0];
      expect(tombstone.deletionStatus).toBe(DeletionStatus.DELETED);
      expect(tombstone.preferences[0].value).toBe('[REDACTED]');

      await second.shutdown();
    } finally {
      await fs.rm(basePath, { recursive: true, force: true });
    }
  });
});
