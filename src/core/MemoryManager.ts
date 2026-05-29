import { v4 as uuidv4 } from 'uuid';
import { Bucket } from './Bucket.js';
import { BucketConfig, Chunk, ChunkLocation, ChunkSummary, Metadata, StorageTier, UserProfileMemory, UserProfileMemoryField, UserProfileMemoryFieldCategory, UserProfilePrivacySettings, UserProfileSnippet, Vector } from './types.js';
import { StorageProvider } from '../providers/StorageProvider.js';
import { LocalStorageProvider } from '../providers/LocalStorageProvider.js';
import { MemoryMonitor, MemoryAlert } from './MemoryMonitor.js';
import { VectorStore } from './VectorStore.js';
import path from 'path';
import os from 'os';

/**
 * The MemoryManager is the main entry point for the InfiniteContext system.
 * It manages buckets, storage providers, and handles routing of data between them.
 */
export class MemoryManager {
  private rootBuckets: Map<string, Bucket> = new Map();
  private storageProviders: Map<string, StorageProvider> = new Map();
  private chunkLocations: Map<string, ChunkLocation> = new Map();
  private profileMemories: Map<string, UserProfileMemory> = new Map();
  private profileLocations: Map<string, ChunkLocation> = new Map();
  private profilePrivacy: UserProfilePrivacySettings = {
    enabled: true,
    disabledFields: [],
    disabledFieldKeys: [],
  };
  private embeddingFunction?: (text: string) => Promise<Vector>;
  private basePath: string;
  private memoryMonitor: MemoryMonitor;
  private alertHandlers: Array<(alert: MemoryAlert) => void> = [];

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
    // Set up default storage provider (local filesystem)
    const localStoragePath = options.localStoragePath || path.join(this.basePath, 'storage');
    const localProvider = new LocalStorageProvider('local', 'Local Storage', localStoragePath);
    await localProvider.connect();
    this.addStorageProvider(localProvider);
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
    return this.storageProviders.delete(id);
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
    
    const bucket = new Bucket(fullConfig);
    this.rootBuckets.set(bucket.getId(), bucket);
    
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
    return this.rootBuckets.delete(id);
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
        
        // Serialize the chunk
        const serializedChunk = Buffer.from(JSON.stringify(chunk));
        
        if (quota.available >= serializedChunk.length) {
          // Store the chunk
          const location = await provider.store(serializedChunk, chunk.metadata);
          
          // Remember where the chunk is stored
          this.chunkLocations.set(chunk.id, location);
          
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
    const location = this.chunkLocations.get(chunkId);
    
    if (!location) {
      throw new Error(`Chunk location not found for ID: ${chunkId}`);
    }
    
    const provider = this.storageProviders.get(location.providerId);
    
    if (!provider) {
      throw new Error(`Storage provider not found for ID: ${location.providerId}`);
    }
    
    // Retrieve the serialized chunk
    const serializedChunk = await provider.retrieve(location);
    
    // Deserialize the chunk
    try {
      return JSON.parse(serializedChunk.toString('utf-8')) as Chunk;
    } catch (error) {
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
    
    // Create the chunk with complete metadata
    const chunk: Chunk = {
      id: uuidv4(),
      content,
      embedding,
      metadata: {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        domain,
        source,
        tags,
        ...metadata
      },
      summaries
    };
    
    return chunk;
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
   * Find the most relevant buckets for a query
   * 
   * @param query - The query text or vector
   * @param k - The number of buckets to return
   * @returns The most relevant buckets with scores
   */
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
}
