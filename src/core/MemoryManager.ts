import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Bucket } from './Bucket.js';
import { BucketConfig, Chunk, ChunkLocation, ChunkSummary, MemoryFeedback, HierarchicalSearchResponse, Metadata, SearchResult, StorageTier, Vector } from './types.js';
import { StorageProvider } from '../providers/StorageProvider.js';
import { LocalStorageProvider } from '../providers/LocalStorageProvider.js';
import { MemoryMonitor, MemoryAlert } from './MemoryMonitor.js';
import { HierarchicalRetriever, HierarchicalRetrieverOptions } from './HierarchicalRetriever.js';
import path from 'path';
import os from 'os';

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
  private embeddingFunction?: (text: string) => Promise<Vector>;
  private basePath: string;
  private manifestPath: string;
  private memoryMonitor: MemoryMonitor;
  private alertHandlers: Array<(alert: MemoryAlert) => void> = [];
  private isInitializing = false;
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
      return JSON.parse(serializedChunk.toString('utf-8')) as Chunk;
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
    if (this.isInitializing) {
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
