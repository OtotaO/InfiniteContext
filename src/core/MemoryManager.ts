import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Bucket } from './Bucket.js';
import { BucketConfig, Chunk, ChunkLocation, ChunkSummary, MemoryFeedback, HierarchicalSearchResponse, Metadata, SearchResult, StorageTier, UserProfileMemory, UserProfileMemoryField, UserProfileMemoryFieldCategory, UserProfilePrivacySettings, UserProfileSnippet, DeletionStatus, MemoryMutationResult, MemoryQuery, ProfileMemory, Vector } from './types.js';
import { StorageProvider } from '../providers/StorageProvider.js';
import { LocalStorageProvider } from '../providers/LocalStorageProvider.js';
import { MemoryMonitor, MemoryAlert } from './MemoryMonitor.js';
import { HierarchicalRetriever, HierarchicalRetrieverOptions } from './HierarchicalRetriever.js';
import path from 'path';
import os from 'os';
import { defaultRetentionFields, deleteChunkMarker, deleteProfileMemoryMarker, memoryMatchesQuery, redactChunk, redactProfileMemory, sanitizeChunkForExport } from '../utils/MemorySafety.js';

interface ManifestProvider {
  id: string;
  name: string;
  tier: StorageTier;
  type: 'local' | 'external';
  basePath?: string;
  maxSizeBytes?: number;
}

interface ManifestBucket {
  config: BucketConfig;
  chunkIds: string[];
  subBuckets: ManifestBucket[];
}

interface ManifestChunk {
  id: string;
  bucketId?: string;
  location: ChunkLocation;
  healthy: boolean;
  unhealthyReason?: string;
}

interface MemoryManifest {
  version: 1;
  updatedAt: string;
  providers: ManifestProvider[];
  buckets: ManifestBucket[];
  chunks: ManifestChunk[];
}

/**
 * The MemoryManager is the main entry point for the InfiniteContext system.
 * It manages buckets, storage providers, and handles routing of data between them.
 */
export class MemoryManager {
  private rootBuckets: Map<string, Bucket> = new Map();
  private storageProviders: Map<string, StorageProvider> = new Map();
  private chunkLocations: Map<string, ChunkLocation> = new Map();
  private unhealthyChunkLocations: Map<string, { location: ChunkLocation; reason: string }> = new Map();
  private profileMemories: Map<string, UserProfileMemory> = new Map();
  private profileLocations: Map<string, ChunkLocation> = new Map();
  private profilePrivacy: UserProfilePrivacySettings = {
    enabled: true,
    disabledFields: [],
    disabledFieldKeys: [],
  };
  // Safety-controlled key/value profile memories (retention, redaction, deletion).
  private safetyProfileMemories: Map<string, ProfileMemory> = new Map();
  private embeddingFunction?: (text: string) => Promise<Vector>;
  private basePath: string;
  private manifestPath: string;
  private memoryMonitor: MemoryMonitor;
  private alertHandlers: Array<(alert: MemoryAlert) => void> = [];
  private isInitializing = false;
  private isShutdown = false;
  private manifestSaveQueue: Promise<void> = Promise.resolve();

  /**
   * Create a new MemoryManager
   *
   * @param options - Configuration options
   */
  constructor(options: {
    basePath?: string;
    embeddingFunction?: (text: string) => Promise<Vector>;
    monitoringConfig?: Partial<{
      bucketSizeThresholdMB: number;
      providerCapacityThresholdPercent: number;
      domainGrowthThresholdPercent: number;
      monitoringIntervalMs: number;
    }>;
  } = {}) {
    this.basePath = options.basePath || path.join(os.homedir(), '.infinite-context');
    this.manifestPath = path.join(this.basePath, 'manifest.json');
    this.embeddingFunction = options.embeddingFunction;

    // Initialize memory monitor
    this.memoryMonitor = new MemoryMonitor({
      ...options.monitoringConfig,
      alertCallback: (alert) => this.handleMemoryAlert(alert)
    });
  }

  /**
   * Initialize the memory manager
   *
   * @param options - Initialization options
   */
  public async initialize(options: {
    localStoragePath?: string;
  } = {}): Promise<void> {
    this.isInitializing = true;

    try {
      await fs.mkdir(this.basePath, { recursive: true });

      // Set up default storage provider (local filesystem)
      const localStoragePath = options.localStoragePath || path.join(this.basePath, 'storage');
      const localProvider = new LocalStorageProvider(localStoragePath, {
        id: 'local',
        name: 'Local Storage',
      });
      await localProvider.connect();
      this.addStorageProvider(localProvider);

      await this.loadManifest();
    } finally {
      this.isInitializing = false;
    }

    await this.saveManifest();
  }

  /**
   * Add a storage provider
   *
   * @param provider - The storage provider to add
   * @returns True if the provider was added, false if a provider with the same ID already exists
   */
  public addStorageProvider(provider: StorageProvider): boolean {
    const id = provider.getId();

    if (this.storageProviders.has(id)) {
      return false;
    }

    this.storageProviders.set(id, provider);
    this.persistManifestInBackground();
    return true;
  }

  /**
   * Get a storage provider by ID
   *
   * @param id - The provider ID
   * @returns The storage provider, or undefined if not found
   */
  public getStorageProvider(id: string): StorageProvider | undefined {
    return this.storageProviders.get(id);
  }

  /**
   * Remove a storage provider
   *
   * @param id - The provider ID
   * @returns True if the provider was removed, false if not found
   */
  public removeStorageProvider(id: string): boolean {
    const removed = this.storageProviders.delete(id);
    if (removed) {
      for (const [chunkId, location] of this.chunkLocations.entries()) {
        if (location.providerId === id) {
          this.chunkLocations.delete(chunkId);
          this.unhealthyChunkLocations.set(chunkId, {
            location,
            reason: `Storage provider ${id} was removed`
          });
        }
      }
      this.persistManifestInBackground();
    }
    return removed;
  }

  /**
   * Get all storage providers
   *
   * @returns A map of provider IDs to providers
   */
  public getStorageProviders(): Map<string, StorageProvider> {
    return new Map(this.storageProviders);
  }

  /**
   * Create a new bucket
   *
   * @param config - The bucket configuration
   * @returns The created bucket
   */
  public createBucket(config: Omit<BucketConfig, 'id'>): Bucket {
    const fullConfig: BucketConfig = {
      id: uuidv4(),
      ...config
    };
    const bucket = new Bucket(fullConfig, undefined, () => this.persistManifestInBackground());
    this.rootBuckets.set(bucket.getId(), bucket);
    this.persistManifestInBackground();

    return bucket;
  }

  /**
   * Get a bucket by ID
   *
   * @param id - The bucket ID
   * @returns The bucket, or undefined if not found
   */
  public getBucket(id: string): Bucket | undefined {
    return this.rootBuckets.get(id);
  }

  /**
   * Remove a bucket
   *
   * @param id - The bucket ID
   * @returns True if the bucket was removed, false if not found
   */
  public removeBucket(id: string): boolean {
    const bucket = this.rootBuckets.get(id);
    const removed = this.rootBuckets.delete(id);

    if (removed && bucket) {
      for (const chunk of bucket.getAllChunks(true)) {
        this.chunkLocations.delete(chunk.id);
        this.unhealthyChunkLocations.delete(chunk.id);
      }
      this.persistManifestInBackground();
    }

    return removed;
  }

  /**
   * Get all root buckets
   *
   * @returns A map of bucket IDs to buckets
   */
  public getBuckets(): Map<string, Bucket> {
    return new Map(this.rootBuckets);
  }


  /**
   * Store a user profile memory separately from normal chunks.
   *
   * Profile memories are not added to bucket vector stores; they are persisted
   * with profile-specific metadata and linked back to source episodes/traces.
   */
  public async storeUserProfileMemory(
    profile: UserProfileMemory,
    preferredTier: StorageTier = StorageTier.LOCAL
  ): Promise<ChunkLocation | undefined> {
    if (!this.profilePrivacy.enabled) {
      return undefined;
    }

    const filteredProfile = this.applyProfilePrivacy(profile);
    if (this.countProfileFields(filteredProfile) === 0) {
      return undefined;
    }

    this.profileMemories.set(filteredProfile.id, filteredProfile);

    const providers = Array.from(this.storageProviders.values())
      .sort((a, b) => {
        if (a.getTier() === preferredTier && b.getTier() !== preferredTier) {
          return -1;
        }
        if (a.getTier() !== preferredTier && b.getTier() === preferredTier) {
          return 1;
        }
        return a.getTier() - b.getTier();
      });

    const serializedProfile = Buffer.from(JSON.stringify(filteredProfile));
    for (const provider of providers) {
      if (!(await provider.isConnected())) {
        continue;
      }

      const quota = await provider.getQuota();
      if (quota.available < serializedProfile.length) {
        continue;
      }

      const location = await provider.store(serializedProfile, {
        type: 'user-profile-memory',
        id: filteredProfile.id,
        userId: filteredProfile.userId,
        sourceEpisodeIds: filteredProfile.sourceEpisodeIds,
        traceIds: filteredProfile.traceIds,
        updatedAt: filteredProfile.updatedAt,
      });
      this.profileLocations.set(filteredProfile.id, location);
      return location;
    }

    return undefined;
  }

  /**
   * Inspect stored profile memories after applying current privacy settings.
   */
  public getUserProfileMemories(userId?: string): UserProfileMemory[] {
    return Array.from(this.profileMemories.values())
      .filter(profile => !userId || profile.userId === userId)
      .map(profile => this.applyProfilePrivacy(profile));
  }

  /**
   * Delete one profile memory or all profile memories for a user.
   */
  public async deleteUserProfileMemory(options: { profileId?: string; userId?: string } = {}): Promise<number> {
    const profiles = Array.from(this.profileMemories.values())
      .filter(profile => (!options.profileId || profile.id === options.profileId) &&
        (!options.userId || profile.userId === options.userId));

    let deleted = 0;
    for (const profile of profiles) {
      const location = this.profileLocations.get(profile.id);
      if (location) {
        const provider = this.storageProviders.get(location.providerId);
        await provider?.delete(location);
        this.profileLocations.delete(profile.id);
      }
      if (this.profileMemories.delete(profile.id)) {
        deleted += 1;
      }
    }

    return deleted;
  }

  public setProfilePrivacy(settings: Partial<UserProfilePrivacySettings>): UserProfilePrivacySettings {
    this.profilePrivacy = {
      ...this.profilePrivacy,
      ...settings,
      disabledFields: settings.disabledFields || this.profilePrivacy.disabledFields,
      disabledFieldKeys: settings.disabledFieldKeys || this.profilePrivacy.disabledFieldKeys,
    };

    return this.getProfilePrivacy();
  }

  public getProfilePrivacy(): UserProfilePrivacySettings {
    return {
      enabled: this.profilePrivacy.enabled,
      disabledFields: [...this.profilePrivacy.disabledFields],
      disabledFieldKeys: [...this.profilePrivacy.disabledFieldKeys],
    };
  }

  public getRelevantProfileSnippets(query: string, options: {
    userId?: string;
    maxSnippets?: number;
    minConfidence?: number;
  } = {}): UserProfileSnippet[] {
    if (!this.profilePrivacy.enabled) {
      return [];
    }

    const queryTerms = new Set(query.toLowerCase().split(/\W+/).filter(term => term.length > 2));
    const maxSnippets = options.maxSnippets || 5;
    const minConfidence = options.minConfidence ?? 0.5;

    const snippets = this.getUserProfileMemories(options.userId)
      .flatMap(profile => this.flattenProfileFields(profile).map(field => ({ profile, field })))
      .filter(({ field }) => field.confidence >= minConfidence)
      .map(({ profile, field }) => ({
        snippet: {
          profileId: profile.id,
          category: field.category,
          key: field.key,
          value: field.value,
          confidence: field.confidence,
          sourceEpisodeIds: field.sourceEpisodeIds,
          traceIds: field.traceIds,
          updatedAt: field.updatedAt,
        } as UserProfileSnippet,
        score: this.scoreProfileField(field, queryTerms),
      }))
      .filter(({ score }) => score > 0 || queryTerms.size === 0);

    snippets.sort((a, b) => b.score - a.score || b.snippet.confidence - a.snippet.confidence);
    return snippets.slice(0, maxSnippets).map(({ snippet }) => snippet);
  }

  private flattenProfileFields(profile: UserProfileMemory): UserProfileMemoryField[] {
    return [
      ...profile.preferences,
      ...profile.interests,
      ...profile.emotionalState,
      ...profile.behavioralPatterns,
    ];
  }

  private countProfileFields(profile: UserProfileMemory): number {
    return this.flattenProfileFields(profile).length;
  }

  private applyProfilePrivacy(profile: UserProfileMemory): UserProfileMemory {
    const filterFields = (fields: UserProfileMemoryField[], category: UserProfileMemoryFieldCategory): UserProfileMemoryField[] => {
      if (this.profilePrivacy.disabledFields.includes(category)) {
        return [];
      }
      return fields.filter(field => {
        const fieldKey = `${category}.${field.key}`;
        return !this.profilePrivacy.disabledFieldKeys.includes(field.key) &&
          !this.profilePrivacy.disabledFieldKeys.includes(fieldKey);
      });
    };

    const filteredProfile: UserProfileMemory = {
      ...profile,
      preferences: filterFields(profile.preferences, 'preferences'),
      interests: filterFields(profile.interests, 'interests'),
      emotionalState: filterFields(profile.emotionalState, 'emotionalState'),
      behavioralPatterns: filterFields(profile.behavioralPatterns, 'behavioralPatterns'),
    };

    const fields = this.flattenProfileFields(filteredProfile);
    filteredProfile.confidence = fields.length === 0
      ? 0
      : fields.reduce((sum, field) => sum + field.confidence, 0) / fields.length;

    return filteredProfile;
  }

  private scoreProfileField(field: UserProfileMemoryField, queryTerms: Set<string>): number {
    if (queryTerms.size === 0) {
      return field.confidence;
    }

    const searchable = `${field.category} ${field.key} ${field.value}`.toLowerCase();
    let matches = 0;
    for (const term of queryTerms) {
      if (searchable.includes(term)) {
        matches += 1;
      }
    }

    return matches / queryTerms.size + field.confidence * 0.1;
  }

  /**
   * Get every chunk currently indexed by all root buckets.
   */
  public getAllChunks(): Chunk[] {
    return Array.from(this.rootBuckets.values()).flatMap(bucket => bucket.getAllChunks(true));
  }

  /**
   * Search indexed memory with either legacy flat search or hierarchical routed retrieval.
   */
  public async searchMemory(
    query: string | Vector,
    options: (HierarchicalRetrieverOptions & { mode?: 'flat' | 'hierarchical'; k?: number }) = {}
  ): Promise<HierarchicalSearchResponse> {
    if (!this.embeddingFunction && typeof query === 'string') {
      throw new Error('No embedding function provided');
    }

    const queryVector = typeof query === 'string'
      ? await this.embeddingFunction!(query)
      : query;
    const chunks = this.getAllChunks();
    const retriever = new HierarchicalRetriever(chunks);

    if (options.mode === 'flat') {
      return retriever.flatSearch(queryVector, options.k ?? options.finalK ?? 10);
    }

    return retriever.search(queryVector, {
      ...options,
      finalK: options.finalK ?? options.k ?? 10,
      episodeK: options.episodeK ?? options.k ?? 10
    });
  }

  /**
   * Legacy flat search across all buckets. Kept as a compatibility fallback.
   */
  public async flatSearchMemory(query: string | Vector, k: number = 10): Promise<SearchResult[]> {
    const response = await this.searchMemory(query, { mode: 'flat', k });
    return response.results.map(({ chunk, score }) => ({ chunk, score }));
  }

  /**
   * Store a chunk in the appropriate storage provider based on tier priority
   *
   * @param chunk - The chunk to store
   * @param preferredTier - The preferred storage tier
   * @returns The location where the chunk was stored
   */
  public async storeChunk(
    chunk: Chunk,
    preferredTier: StorageTier = StorageTier.LOCAL
  ): Promise<ChunkLocation> {
    // Find available providers, starting with the preferred tier
    const providers = Array.from(this.storageProviders.values())
      .sort((a, b) => {
        // Sort by tier (preferred first), then by available space (most first)
        if (a.getTier() === preferredTier && b.getTier() !== preferredTier) {
          return -1;
        }
        if (a.getTier() !== preferredTier && b.getTier() === preferredTier) {
          return 1;
        }
        return a.getTier() - b.getTier();
      });

    if (providers.length === 0) {
      throw new Error('No storage providers available');
    }

    // Try each provider in order
    let lastError: Error | undefined;
    for (const provider of providers) {
      if (!(await provider.isConnected())) {
        continue;
      }

      try {
        // Check if there's enough space
        const quota = await provider.getQuota();

        chunk.metadata.hash = await this.calculateChunkHash(chunk);
        // Serialize the chunk
        const serializedChunk = Buffer.from(JSON.stringify(chunk));

        if (quota.available >= serializedChunk.length) {
          // Store the chunk
          const location = await provider.store(serializedChunk, chunk.metadata);

          // Remember where the chunk is stored
          this.chunkLocations.set(chunk.id, location);
          this.unhealthyChunkLocations.delete(chunk.id);
          await this.saveManifest();

          return location;
        }
      } catch (error) {
        lastError = error as Error;
        console.warn(`Failed to store chunk in provider ${provider.getName()}: ${error}`);
      }
    }

    throw lastError || new Error('Failed to store chunk in any provider');
  }

  /**
   * Retrieve a chunk from its stored location
   *
   * @param chunkId - The ID of the chunk to retrieve
   * @returns The retrieved chunk
   */
  public async retrieveChunk(chunkId: string): Promise<Chunk> {
    const unhealthy = this.unhealthyChunkLocations.get(chunkId);
    if (unhealthy) {
      throw new Error(`Chunk ${chunkId} is unhealthy: ${unhealthy.reason}`);
    }

    const location = this.chunkLocations.get(chunkId);

    if (!location) {
      throw new Error(`Chunk location not found for ID: ${chunkId}`);
    }

    const provider = this.storageProviders.get(location.providerId);

    if (!provider) {
      this.markChunkUnhealthy(chunkId, location, `Storage provider not found for ID: ${location.providerId}`);
      throw new Error(`Storage provider not found for ID: ${location.providerId}`);
    }

    // Retrieve the serialized chunk
    const serializedChunk = await provider.retrieve(location);

    // Deserialize the chunk
    try {
      const chunk = JSON.parse(serializedChunk.toString('utf-8')) as Chunk;
      const storedHash = chunk.metadata.hash as string | undefined;
      if (storedHash) {
        const currentHash = await this.calculateChunkHash({ ...chunk, metadata: { ...chunk.metadata, hash: undefined } });
        if (currentHash !== storedHash) {
          throw new Error(`Stored chunk integrity check failed for ID: ${chunkId}`);
        }
      }
      return chunk;
    } catch (error) {
      this.markChunkUnhealthy(chunkId, location, `Failed to deserialize chunk: ${error}`);
      throw new Error(`Failed to deserialize chunk: ${error}`);
    }
  }

  /**
   * Create a chunk from text content
   *
   * @param content - The text content
   * @param metadata - The chunk metadata
   * @param summarize - Whether to generate summaries for the chunk
   * @returns The created chunk
   */
  public async createChunk(
    content: string,
    metadata: Partial<Omit<Metadata, 'id' | 'timestamp'>>,
    summarize: boolean = true
  ): Promise<Chunk> {
    if (!this.embeddingFunction) {
      throw new Error('No embedding function provided');
    }

    // Generate embedding
    const embedding = await this.embeddingFunction(content);

    // Generate summaries if requested
    const summaries: ChunkSummary[] = summarize
      ? await this.generateSummaries(content)
      : [];

    // Extract metadata with proper defaults
    const domain = metadata.domain as string || 'default';
    const source = metadata.source as string || 'user';
    const tags = metadata.tags as string[] || [];

    const now = new Date().toISOString();

    // Create the chunk with complete metadata and memory lifecycle state
    const chunk: Chunk = {
      id: uuidv4(),
      content,
      embedding,
      metadata: {
        id: uuidv4(),
        timestamp: now,
        domain,
        source,
        tags,
        ...defaultRetentionFields(),
        ...metadata
      },
      summaries,
      memory: {
        weight: 1,
        lastAccessedAt: now,
        accessCount: 0,
        decayRate: 0.01,
      }
    };

    return chunk;
  }


  /**
   * Create or update a profile memory with retention metadata.
   */
  public upsertProfileMemory(memory: Omit<ProfileMemory, 'id' | 'createdAt' | 'updatedAt' | 'retentionPolicy' | 'sensitivity' | 'deletionStatus'> & Partial<Pick<ProfileMemory, 'id' | 'createdAt' | 'retentionPolicy' | 'sensitivity' | 'deletionStatus'>>): ProfileMemory {
    const existing = memory.id ? this.safetyProfileMemories.get(memory.id) : undefined;
    const now = new Date().toISOString();
    const profileMemory: ProfileMemory = {
      ...defaultRetentionFields(),
      ...existing,
      ...memory,
      id: memory.id || existing?.id || uuidv4(),
      tags: memory.tags || existing?.tags || [],
      createdAt: memory.createdAt || existing?.createdAt || now,
      updatedAt: now,
    };

    this.safetyProfileMemories.set(profileMemory.id, profileMemory);
    return profileMemory;
  }

  /**
   * List chunk and profile memories matching safety filters.
   */
  public listMemories(query: MemoryQuery = {}): { chunks: Chunk[]; profileMemories: ProfileMemory[] } {
    const chunks = Array.from(this.rootBuckets.values())
      .flatMap(bucket => bucket.getAllChunks(true, true))
      .filter(chunk => memoryMatchesQuery(chunk, query));
    const profileMemories = Array.from(this.safetyProfileMemories.values())
      .filter(memory => memoryMatchesQuery(memory, query));
    return { chunks, profileMemories };
  }

  /**
   * Redact matching memories while preserving tombstones for auditability.
   */
  public redactMemories(query: MemoryQuery, reason?: string): MemoryMutationResult {
    return this.mutateMemories(query, chunk => redactChunk(chunk, reason), memory => redactProfileMemory(memory, reason));
  }

  /**
   * Mark matching memories deleted while retaining deletion markers.
   */
  public deleteMemories(query: MemoryQuery, reason?: string): MemoryMutationResult {
    return this.mutateMemories({ ...query, includeDeleted: true }, chunk => deleteChunkMarker(chunk, reason), memory => deleteProfileMemoryMarker(memory, reason));
  }

  /**
   * Export matching memories with redacted/deleted records sanitized.
   */
  public exportMemories(query: MemoryQuery = {}): { chunks: Chunk[]; profileMemories: ProfileMemory[] } {
    const memories = this.listMemories({ ...query, includeDeleted: query.includeDeleted ?? false });
    return {
      chunks: memories.chunks
        .map(chunk => sanitizeChunkForExport(chunk, !!query.includeDeleted))
        .filter((chunk): chunk is Chunk => chunk !== null),
      profileMemories: memories.profileMemories.map(memory => {
        if (memory.deletionStatus === DeletionStatus.REDACTED || memory.deletionStatus === DeletionStatus.DELETED) {
          return redactProfileMemory(memory, memory.deletionReason);
        }
        return { ...memory };
      }),
    };
  }

  private mutateMemories(query: MemoryQuery, chunkMutator: (chunk: Chunk) => Chunk, profileMutator: (memory: ProfileMemory) => ProfileMemory): MemoryMutationResult {
    let matched = 0;
    let changed = 0;

    for (const bucket of this.rootBuckets.values()) {
      for (const chunk of bucket.getAllChunks(true, true)) {
        if (!memoryMatchesQuery(chunk, query)) continue;
        matched++;
        const updated = chunkMutator(chunk);
        if (bucket.updateChunk(updated, true)) changed++;
      }
    }

    for (const memory of this.safetyProfileMemories.values()) {
      if (!memoryMatchesQuery(memory, query)) continue;
      matched++;
      this.safetyProfileMemories.set(memory.id, profileMutator(memory));
      changed++;
    }

    return { matched, changed };
  }

  private async calculateChunkHash(chunk: Chunk): Promise<string> {
    const { calculateChunkHash } = await import('../utils/IntegrityVerifier.js');
    return calculateChunkHash(chunk);
  }

  /**
   * Generate summaries for a chunk of text
   *
   * @param content - The text content
   * @returns An array of summaries at different levels
   */
  private async generateSummaries(content: string): Promise<ChunkSummary[]> {
    // This is a placeholder implementation
    // In a real implementation, this would use an LLM to generate summaries

    const summary: ChunkSummary = {
      level: 1,
      content: content.length > 100
        ? content.substring(0, 100) + '...'
        : content,
      concepts: []
    };

    return [summary];
  }

  /**
   * Record user feedback for a memory chunk across all buckets.
   *
   * Rebutted memories are marked stale and down-weighted, not deleted, so they
   * can still be audited or revived by later approval.
   *
   * @param chunkId - The chunk ID receiving feedback
   * @param feedback - Approval, neutral signal, or rebuttal
   * @returns The updated chunk, or undefined if no chunk matched
   */
  public recordMemoryFeedback(chunkId: string, feedback: MemoryFeedback): Chunk | undefined {
    for (const bucket of this.rootBuckets.values()) {
      const chunk = bucket.recordMemoryFeedback(chunkId, feedback, true);
      if (chunk) {
        return chunk;
      }
    }

    return undefined;
  }

  /**
   * Add a memory alert handler
   *
   * @param handler - The handler function to add
   */
  public addAlertHandler(handler: (alert: MemoryAlert) => void): void {
    this.alertHandlers.push(handler);
  }

  /**
   * Remove a memory alert handler
   *
   * @param handler - The handler function to remove
   * @returns True if the handler was removed, false if not found
   */
  public removeAlertHandler(handler: (alert: MemoryAlert) => void): boolean {
    const index = this.alertHandlers.indexOf(handler);
    if (index >= 0) {
      this.alertHandlers.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Get all current memory alerts
   *
   * @param includeAcknowledged - Whether to include acknowledged alerts
   * @returns Array of alerts
   */
  public getMemoryAlerts(includeAcknowledged: boolean = false): MemoryAlert[] {
    return this.memoryMonitor.getAlerts(includeAcknowledged);
  }

  /**
   * Acknowledge a memory alert
   *
   * @param alertId - The ID of the alert to acknowledge
   * @returns True if the alert was found and acknowledged, false otherwise
   */
  public acknowledgeMemoryAlert(alertId: string): boolean {
    return this.memoryMonitor.acknowledgeAlert(alertId);
  }

  /**
   * Get memory usage statistics
   *
   * @returns Memory usage statistics
   */
  public async getMemoryStats(): Promise<any> {
    return this.memoryMonitor.getMemoryStats();
  }

  /**
   * Start monitoring memory usage
   */
  public startMemoryMonitoring(): void {
    // Update the monitor with current buckets and providers
    this.memoryMonitor.registerBuckets(this.rootBuckets);
    this.memoryMonitor.registerProviders(this.storageProviders);

    // Start monitoring
    this.memoryMonitor.startMonitoring();
  }

  /**
   * Stop monitoring memory usage
   */
  public stopMemoryMonitoring(): void {
    this.memoryMonitor.stopMonitoring();
  }

  /**
   * Gracefully shut down the memory manager.
   *
   * Stops the monitoring timer and flushes any in-flight background manifest
   * writes, then blocks further background persistence. Callers (and tests)
   * should await this before discarding the instance or its base directory to
   * avoid writes racing against teardown.
   */
  public async shutdown(): Promise<void> {
    if (this.isShutdown) {
      await this.manifestSaveQueue.catch(() => {});
      return;
    }

    this.memoryMonitor.stopMonitoring();

    // Block further background persistence first, so nothing new is appended to
    // the queue while we drain it.
    this.isShutdown = true;

    // Drain any queued background writes that were scheduled before shutdown.
    await this.manifestSaveQueue.catch(() => {});
  }

  /**
   * Handle a memory alert
   *
   * @param alert - The alert to handle
   */
  private handleMemoryAlert(alert: MemoryAlert): void {
    // Notify all registered handlers
    for (const handler of this.alertHandlers) {
      try {
        handler(alert);
      } catch (error) {
        console.error('Error in memory alert handler:', error);
      }
    }

    // Log the alert
    console.warn(`Memory Alert [${alert.severity}]: ${alert.message}`);
  }

  public async findRelevantBuckets(
    query: string | Vector,
    k: number = 3
  ): Promise<Array<{ bucket: Bucket, score: number }>> {
    if (!this.embeddingFunction && typeof query === 'string') {
      throw new Error('No embedding function provided');
    }

    // Convert query to vector if it's a string
    const queryVector = typeof query === 'string'
      ? await this.embeddingFunction!(query)
      : query;

    // Calculate relevance scores for each bucket
    const results: Array<{ bucket: Bucket, score: number }> = [];

    for (const bucket of this.rootBuckets.values()) {
      // Get a sample of chunks from the bucket
      const searchResults = bucket.search(queryVector, 5, true);

      if (searchResults.length === 0) {
        continue;
      }

      // Calculate average score
      const avgScore = searchResults.reduce((sum, result) => sum + result.score, 0) / searchResults.length;

      results.push({
        bucket,
        score: avgScore
      });
    }

    // Sort by score (descending) and limit to k results
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, k);
  }

  private persistManifestInBackground(): void {
    if (this.isInitializing || this.isShutdown) {
      return;
    }

    this.manifestSaveQueue = this.manifestSaveQueue
      .then(() => this.writeManifest())
      .catch((error) => {
        console.warn(`Failed to persist memory manifest: ${error}`);
      });
  }

  private async saveManifest(): Promise<void> {
    if (this.isInitializing) {
      return;
    }

    this.manifestSaveQueue = this.manifestSaveQueue.then(() => this.writeManifest());
    await this.manifestSaveQueue;
  }

  private async writeManifest(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });

    const manifest = this.createManifest();
    const tempPath = `${this.manifestPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf-8');
    await fs.rename(tempPath, this.manifestPath);
  }

  private createManifest(): MemoryManifest {
    const bucketChunkIds = new Map<string, string>();
    const buckets = Array.from(this.rootBuckets.values()).map((bucket) => this.serializeBucket(bucket, bucketChunkIds));
    const chunks: ManifestChunk[] = [];

    for (const [id, location] of this.chunkLocations.entries()) {
      chunks.push({
        id,
        bucketId: bucketChunkIds.get(id),
        location,
        healthy: true
      });
    }

    for (const [id, unhealthy] of this.unhealthyChunkLocations.entries()) {
      chunks.push({
        id,
        bucketId: bucketChunkIds.get(id),
        location: unhealthy.location,
        healthy: false,
        unhealthyReason: unhealthy.reason
      });
    }

    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      providers: Array.from(this.storageProviders.values()).map((provider) => this.serializeProvider(provider)),
      buckets,
      chunks
    };
  }

  private serializeProvider(provider: StorageProvider): ManifestProvider {
    const base: ManifestProvider = {
      id: provider.getId(),
      name: provider.getName(),
      tier: provider.getTier(),
      type: 'external'
    };

    if (provider instanceof LocalStorageProvider) {
      return {
        ...base,
        type: 'local',
        basePath: provider.getBasePath(),
        maxSizeBytes: provider.getMaxSizeBytes()
      };
    }

    return base;
  }

  private serializeBucket(bucket: Bucket, bucketChunkIds: Map<string, string>): ManifestBucket {
    const chunkIds = bucket.getChunks().map((chunk) => {
      bucketChunkIds.set(chunk.id, bucket.getId());
      return chunk.id;
    });

    return {
      config: bucket.getConfig(),
      chunkIds,
      subBuckets: Array.from(bucket.getSubBuckets().values()).map((subBucket) => this.serializeBucket(subBucket, bucketChunkIds))
    };
  }

  private async loadManifest(): Promise<void> {
    let manifest: MemoryManifest;

    try {
      const manifestData = await fs.readFile(this.manifestPath, 'utf-8');
      manifest = JSON.parse(manifestData) as MemoryManifest;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return;
      }
      console.warn(`Failed to load memory manifest; starting without persisted metadata: ${error}`);
      return;
    }

    if (!manifest || manifest.version !== 1) {
      console.warn('Unsupported memory manifest version; starting without persisted metadata');
      return;
    }

    await this.restoreManifestProviders(manifest.providers || []);

    const restoredBuckets = new Map<string, Bucket>();
    const rootBuckets = new Map<string, Bucket>();
    for (const manifestBucket of manifest.buckets || []) {
      const bucket = this.deserializeBucket(manifestBucket, restoredBuckets);
      rootBuckets.set(bucket.getId(), bucket);
    }

    this.rootBuckets = rootBuckets;
    this.chunkLocations.clear();
    this.unhealthyChunkLocations.clear();

    const bucketChunkIds = new Map<string, string>();
    for (const manifestBucket of manifest.buckets || []) {
      this.collectManifestBucketChunkIds(manifestBucket, bucketChunkIds);
    }

    for (const manifestChunk of manifest.chunks || []) {
      const chunkBucketId = manifestChunk.bucketId || bucketChunkIds.get(manifestChunk.id);
      const bucket = chunkBucketId ? restoredBuckets.get(chunkBucketId) : undefined;
      await this.restoreManifestChunk(manifestChunk, bucket);
    }
  }

  private async restoreManifestProviders(providers: ManifestProvider[]): Promise<void> {
    for (const provider of providers) {
      if (this.storageProviders.has(provider.id)) {
        continue;
      }

      if (provider.type === 'local' && provider.basePath) {
        const localProvider = new LocalStorageProvider(provider.basePath, {
          id: provider.id,
          name: provider.name,
          maxSizeBytes: provider.maxSizeBytes,
        });
        await localProvider.connect();
        this.storageProviders.set(provider.id, localProvider);
      }
    }
  }

  private deserializeBucket(manifestBucket: ManifestBucket, allBuckets: Map<string, Bucket>): Bucket {
    const bucket = new Bucket(manifestBucket.config, undefined, () => this.persistManifestInBackground());
    allBuckets.set(bucket.getId(), bucket);

    for (const manifestSubBucket of manifestBucket.subBuckets || []) {
      const subBucket = this.deserializeBucket(manifestSubBucket, allBuckets);
      bucket.addExistingSubBucket(subBucket);
    }

    return bucket;
  }

  private collectManifestBucketChunkIds(manifestBucket: ManifestBucket, bucketChunkIds: Map<string, string>): void {
    for (const chunkId of manifestBucket.chunkIds || []) {
      bucketChunkIds.set(chunkId, manifestBucket.config.id);
    }

    for (const subBucket of manifestBucket.subBuckets || []) {
      this.collectManifestBucketChunkIds(subBucket, bucketChunkIds);
    }
  }

  private async restoreManifestChunk(manifestChunk: ManifestChunk, bucket?: Bucket): Promise<void> {
    const location = manifestChunk.location;
    const provider = this.storageProviders.get(location.providerId);

    if (!provider) {
      this.markChunkUnhealthy(manifestChunk.id, location, `Storage provider not found for ID: ${location.providerId}`);
      return;
    }

    try {
      if (!(await provider.isConnected())) {
        this.markChunkUnhealthy(manifestChunk.id, location, `Storage provider ${location.providerId} is not connected`);
        return;
      }

      if (!(await provider.exists(location))) {
        this.markChunkUnhealthy(manifestChunk.id, location, 'Stored chunk file is missing');
        return;
      }

      const serializedChunk = await provider.retrieve(location);
      const chunk = JSON.parse(serializedChunk.toString('utf-8')) as Chunk;

      this.chunkLocations.set(manifestChunk.id, location);
      if (bucket) {
        bucket.addChunk(chunk);
      }
    } catch (error) {
      this.markChunkUnhealthy(manifestChunk.id, location, `Failed to restore chunk: ${error}`);
    }
  }

  private markChunkUnhealthy(chunkId: string, location: ChunkLocation, reason: string): void {
    this.chunkLocations.delete(chunkId);
    this.unhealthyChunkLocations.set(chunkId, { location, reason });
  }
}
