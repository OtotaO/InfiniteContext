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
  category?: string;
  memoryTraceId?: string;
  traceId?: string;
  parentId?: string;
  childIds?: string[];
  hierarchyLevel?: HierarchyLevel;
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

export interface MemoryMetadata {
  /**
   * Confidence/importance multiplier for retrieval. Defaults to 1.0.
   */
  weight: number;
  /**
   * ISO timestamp for the most recent retrieval access.
   */
  lastAccessedAt: string;
  /**
   * Number of times this memory has been returned from retrieval.
   */
  accessCount: number;
  /**
   * Exponential decay rate applied per day since last access.
   */
  decayRate: number;
  /**
   * ISO timestamp set when a memory is rebutted/stale.
   */
  invalidatedAt?: string;
}

export type MemoryFeedback = 'approve' | 'neutral' | 'rebut';

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
  /**
   * Lifecycle metadata used for decay-aware retrieval scoring. Optional because
   * chunks may be constructed before metadata is stamped; the vector store
   * lazily initializes it via ensureMemoryMetadata.
   */
  memory?: MemoryMetadata;
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

export interface ExtractedMemory {
  domain: string;
  category: string;
  memoryTrace: string;
  episodeText: string;
  timestamp: string;
  userProfileAttributes: Record<string, unknown>;
  confidence: number;
}

export interface MemoryExtractionInput {
  prompt: string;
  output: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryExtractor {
  extractMemory(input: MemoryExtractionInput): Promise<ExtractedMemory | null>;
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
