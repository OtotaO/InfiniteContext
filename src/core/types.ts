/**
 * Core type definitions for the Infinite Context system
 */

export type Vector = number[];

export enum RetentionPolicy {
  TRANSIENT = 'transient',
  STANDARD = 'standard',
  ARCHIVE = 'archive',
  LEGAL_HOLD = 'legal_hold'
}

export enum SensitivityLevel {
  PUBLIC = 'public',
  INTERNAL = 'internal',
  CONFIDENTIAL = 'confidential',
  RESTRICTED = 'restricted'
}

export enum DeletionStatus {
  ACTIVE = 'active',
  REDACTED = 'redacted',
  DELETED = 'deleted'
}

export interface RetentionMetadata {
  retentionPolicy?: RetentionPolicy | string;
  expiresAt?: string;
  sensitivity?: SensitivityLevel | string;
  deletionStatus?: DeletionStatus | string;
  deletedAt?: string;
  redactedAt?: string;
  deletionReason?: string;
}

export interface Metadata extends RetentionMetadata {
  id: string;
  userId?: string;
  domain: string;
  bucket?: string;
  bucketId?: string;
  bucketName?: string;
  timestamp: string;
  source: string;
  tags: string[];
  [key: string]: unknown;
}

export interface ProfileMemory {
  id: string;
  userId: string;
  domain: string;
  bucket?: string;
  key: string;
  value: unknown;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  retentionPolicy?: RetentionPolicy | string;
  expiresAt?: string;
  sensitivity?: SensitivityLevel | string;
  deletionStatus?: DeletionStatus | string;
  deletedAt?: string;
  redactedAt?: string;
  deletionReason?: string;
}

export interface MemoryQuery {
  userId?: string;
  domain?: string;
  bucket?: string;
  bucketId?: string;
  bucketName?: string;
  tag?: string;
  tags?: string[];
  sensitivity?: SensitivityLevel | string;
  includeExpired?: boolean;
  includeDeleted?: boolean;
}

export interface MemoryMutationResult {
  matched: number;
  changed: number;
}

export interface ChunkSummary {
  level: number;
  content: string;
  concepts: string[];
}

export interface Chunk {
  id: string;
  content: string;
  embedding: Vector;
  metadata: Metadata;
  summaries: ChunkSummary[];
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
}

export interface StorageQuota {
  used: number;
  total: number;
  available: number;
}

export enum StorageTier {
  MEMORY = 0,
  LOCAL = 1,
  CLOUD = 2,
  PLATFORM = 3,
  EXTENDED = 4
}

export interface StorageProviderInfo {
  id: string;
  name: string;
  tier: StorageTier;
  isConnected: boolean;
  quota: StorageQuota;
}

export interface ChunkLocation {
  providerId: string;
  key: string;
}

export type EmbeddingFunction = (text: string) => Promise<Vector>;

export interface BucketConfig {
  id: string;
  name: string;
  domain: string;
  description?: string;
  parentId?: string;
}
