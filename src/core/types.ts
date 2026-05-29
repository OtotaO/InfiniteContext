/**
 * Core type definitions for the Infinite Context system
 */

export type Vector = number[];

export interface Metadata {
  id: string;
  domain: string;
  timestamp: string;
  source: string;
  tags: string[];
  [key: string]: unknown;
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

/**
 * Categories of long-lived user profile memory that can be extracted from episodes.
 */
export type UserProfileMemoryFieldCategory =
  | 'preferences'
  | 'interests'
  | 'emotionalState'
  | 'behavioralPatterns';

export interface UserProfileMemoryField {
  id: string;
  category: UserProfileMemoryFieldCategory;
  key: string;
  value: string;
  evidence?: string;
  confidence: number;
  sourceEpisodeIds: string[];
  traceIds: string[];
  createdAt: string;
  updatedAt: string;
  lastObservedAt: string;
}

export interface UserProfileMemory {
  id: string;
  userId?: string;
  preferences: UserProfileMemoryField[];
  interests: UserProfileMemoryField[];
  emotionalState: UserProfileMemoryField[];
  behavioralPatterns: UserProfileMemoryField[];
  sourceEpisodeIds: string[];
  traceIds: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastObservedAt: string;
}

export interface UserProfilePrivacySettings {
  enabled: boolean;
  disabledFields: UserProfileMemoryFieldCategory[];
  disabledFieldKeys: string[];
}

export interface UserProfileSnippet {
  profileId: string;
  category: UserProfileMemoryFieldCategory;
  key: string;
  value: string;
  confidence: number;
  sourceEpisodeIds: string[];
  traceIds: string[];
  updatedAt: string;
}
