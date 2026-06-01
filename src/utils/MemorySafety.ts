import { Chunk, DeletionStatus, MemoryQuery, ProfileMemory, RetentionPolicy, SensitivityLevel, UserProfileMemory, UserProfileMemoryField } from '../core/types.js';

export const REDACTED_TEXT = '[REDACTED]';

export function defaultRetentionFields(now: Date = new Date()) {
  return {
    retentionPolicy: RetentionPolicy.STANDARD,
    sensitivity: SensitivityLevel.INTERNAL,
    deletionStatus: DeletionStatus.ACTIVE,
  };
}

export function isExpired(chunk: Chunk | ProfileMemory, now: Date = new Date()): boolean {
  const expiresAt = 'metadata' in chunk ? chunk.metadata.expiresAt : chunk.expiresAt;
  return typeof expiresAt === 'string' && new Date(expiresAt).getTime() <= now.getTime();
}

export function isDeleted(chunk: Chunk | ProfileMemory): boolean {
  const deletionStatus = 'metadata' in chunk ? chunk.metadata.deletionStatus : chunk.deletionStatus;
  return deletionStatus === DeletionStatus.DELETED;
}

export function isRetrievable(chunk: Chunk | ProfileMemory, now: Date = new Date()): boolean {
  return !isDeleted(chunk) && !isExpired(chunk, now);
}

export function memoryMatchesQuery(memory: Chunk | ProfileMemory, query: MemoryQuery = {}): boolean {
  const metadata = 'metadata' in memory ? memory.metadata : memory;
  if (!query.includeDeleted && metadata.deletionStatus === DeletionStatus.DELETED) return false;
  if (!query.includeExpired && isExpired(memory)) return false;
  if (query.userId && metadata.userId !== query.userId) return false;
  if (query.domain && metadata.domain !== query.domain) return false;
  const bucketName = 'bucketName' in metadata ? metadata.bucketName : undefined;
  const bucketId = 'bucketId' in metadata ? metadata.bucketId : undefined;
  if (query.bucket && metadata.bucket !== query.bucket && bucketName !== query.bucket) return false;
  if (query.bucketId && bucketId !== query.bucketId) return false;
  if (query.bucketName && bucketName !== query.bucketName && metadata.bucket !== query.bucketName) return false;
  if (query.sensitivity && metadata.sensitivity !== query.sensitivity) return false;
  const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  if (query.tag && !tags.includes(query.tag)) return false;
  if (query.tags?.length && !query.tags.every(tag => tags.includes(tag))) return false;
  return true;
}

export function redactChunk(chunk: Chunk, reason?: string): Chunk {
  return {
    ...chunk,
    content: REDACTED_TEXT,
    embedding: [],
    summaries: [],
    metadata: {
      ...chunk.metadata,
      deletionStatus: DeletionStatus.REDACTED,
      redactedAt: new Date().toISOString(),
      deletionReason: reason || chunk.metadata.deletionReason,
    },
  };
}

export function deleteChunkMarker(chunk: Chunk, reason?: string): Chunk {
  return {
    ...redactChunk(chunk, reason),
    metadata: {
      ...chunk.metadata,
      deletionStatus: DeletionStatus.DELETED,
      deletedAt: new Date().toISOString(),
      deletionReason: reason || chunk.metadata.deletionReason,
    },
  };
}

export function redactProfileMemory(memory: ProfileMemory, reason?: string): ProfileMemory {
  return {
    ...memory,
    value: REDACTED_TEXT,
    deletionStatus: DeletionStatus.REDACTED,
    redactedAt: new Date().toISOString(),
    deletionReason: reason || memory.deletionReason,
    updatedAt: new Date().toISOString(),
  };
}

export function deleteProfileMemoryMarker(memory: ProfileMemory, reason?: string): ProfileMemory {
  return {
    ...redactProfileMemory(memory, reason),
    deletionStatus: DeletionStatus.DELETED,
    deletedAt: new Date().toISOString(),
  };
}

/**
 * Whether an extracted user-profile aggregate matches a governance query.
 *
 * Profiles are user-scoped aggregates without domain/bucket/tag/sensitivity
 * facets, so they are only caught by broad, user-scoped (or unscoped) queries —
 * exactly the right-to-access / right-to-erasure semantics. A query that pins a
 * chunk-specific facet (domain, bucket, tag, sensitivity) deliberately excludes
 * profiles rather than over-matching them.
 */
export function userProfileMatchesQuery(profile: UserProfileMemory, query: MemoryQuery = {}): boolean {
  if (!query.includeDeleted && profile.deletionStatus === DeletionStatus.DELETED) return false;
  if (query.userId && profile.userId !== query.userId) return false;
  // Facets a profile aggregate cannot satisfy: presence means "not a profile".
  if (query.domain || query.bucket || query.bucketId || query.bucketName) return false;
  if (query.tag || (query.tags && query.tags.length > 0)) return false;
  if (query.sensitivity) return false;
  return true;
}

function redactProfileField(field: UserProfileMemoryField): UserProfileMemoryField {
  return { ...field, value: REDACTED_TEXT, evidence: field.evidence ? REDACTED_TEXT : field.evidence };
}

export function redactUserProfile(profile: UserProfileMemory, reason?: string): UserProfileMemory {
  const now = new Date().toISOString();
  return {
    ...profile,
    preferences: profile.preferences.map(redactProfileField),
    interests: profile.interests.map(redactProfileField),
    emotionalState: profile.emotionalState.map(redactProfileField),
    behavioralPatterns: profile.behavioralPatterns.map(redactProfileField),
    deletionStatus: DeletionStatus.REDACTED,
    redactedAt: now,
    updatedAt: now,
    deletionReason: reason || profile.deletionReason,
  };
}

export function deleteUserProfileMarker(profile: UserProfileMemory, reason?: string): UserProfileMemory {
  return {
    ...redactUserProfile(profile, reason),
    deletionStatus: DeletionStatus.DELETED,
    deletedAt: new Date().toISOString(),
  };
}

export function sanitizeUserProfileForExport(profile: UserProfileMemory, includeDeleted = false): UserProfileMemory | null {
  if (profile.deletionStatus === DeletionStatus.DELETED && !includeDeleted) {
    return null;
  }
  if (profile.deletionStatus === DeletionStatus.REDACTED || profile.deletionStatus === DeletionStatus.DELETED) {
    return redactUserProfile(profile, profile.deletionReason);
  }
  return { ...profile };
}

export function sanitizeChunkForExport(chunk: Chunk, includeDeleted = false): Chunk | null {
  if (chunk.metadata.deletionStatus === DeletionStatus.DELETED && !includeDeleted) {
    return null;
  }
  if (chunk.metadata.deletionStatus === DeletionStatus.REDACTED || chunk.metadata.deletionStatus === DeletionStatus.DELETED) {
    return redactChunk(chunk, chunk.metadata.deletionReason as string | undefined);
  }
  return { ...chunk, metadata: { ...chunk.metadata } };
}
