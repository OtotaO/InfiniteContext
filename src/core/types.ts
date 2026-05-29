/**
 * Core type definitions for the Infinite Context system
 */

export type Vector = number[];

export enum HierarchyLevel {
  DOMAIN = 'domain',
  CATEGORY = 'category',
  MEMORY_TRACE = 'memoryTrace',
  EPISODE = 'episode'
}

export interface Metadata {
  id: string;
  domain: string;
  timestamp: string;
  source: string;
  tags: string[];
  category?: string;
  memoryTraceId?: string;
  traceId?: string;
  parentId?: string;
  childIds?: string[];
  hierarchyLevel?: HierarchyLevel;
  [key: string]: unknown;
}

export interface ChunkSummary {
  level: number;
  content: string;
  concepts: string[];
}

export interface HierarchyPointer {
  level: HierarchyLevel;
  parentId?: string;
  childIds: string[];
  path: string[];
}

export interface Chunk {
  id: string;
  content: string;
  embedding: Vector;
  metadata: Metadata;
  summaries: ChunkSummary[];
  hierarchy?: HierarchyPointer;
}

export interface HierarchicalMemoryRecord {
  id: string;
  level: HierarchyLevel;
  label: string;
  embedding: Vector;
  metadata: Record<string, unknown>;
  parentId?: string;
  childIds: string[];
  chunk?: Chunk;
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
}

export interface HierarchicalSearchResult extends SearchResult {
  path: Array<{ id: string; label: string; level: HierarchyLevel; score: number }>;
}

export interface HierarchicalSearchStats {
  mode: 'flat' | 'hierarchical';
  flatCandidateCount: number;
  routedCandidateCount: number;
  candidatesByLevel: Record<HierarchyLevel, number>;
}

export interface HierarchicalSearchResponse {
  results: HierarchicalSearchResult[];
  stats: HierarchicalSearchStats;
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
