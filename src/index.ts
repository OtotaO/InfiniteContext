/**
 * InfiniteContext: An extensible memory architecture for AI systems
 *
 * This library provides a framework for storing, organizing, and retrieving
 * large amounts of contextual information across various storage tiers.
 */

// Core components
export { MemoryManager } from './core/MemoryManager.js';
export { Bucket } from './core/Bucket.js';
export { VectorStore } from './core/VectorStore.js';
export { HierarchicalRetriever, type HierarchicalRetrieverOptions } from './core/HierarchicalRetriever.js';
export { ProfileMemoryExtractor, type ProfileMemoryExtractorOptions, type ProfileExtractionInput } from './core/ProfileMemoryExtractor.js';
export { MemoryMonitor, type MemoryAlert } from './core/MemoryMonitor.js';
export { DeterministicMemoryExtractor, extractedMemoryJsonSchema } from './core/MemoryExtractor.js';
export * from './core/types.js';

// Storage providers
export { StorageProvider } from './providers/StorageProvider.js';
export { LocalStorageProvider } from './providers/LocalStorageProvider.js';
export { GoogleDriveProvider } from './providers/GoogleDriveProvider.js';

// Summarization
export { SummarizationEngine } from './summarization/SummarizationEngine.js';

// Utilities
export * from './utils/ErrorHandler.js';
export * from './utils/TransactionManager.js';
export * from './utils/IntegrityVerifier.js';
export * from './utils/BackupManager.js';
export * from './utils/DataPortability.js';
export * from './utils/IndexManager.js';

// Categorization
export { PromptCategorizer } from './categorization/PromptCategorizer.js';
export * from './categorization/models/CategoryModel.js';

// Re-export OpenAI for convenience
import { OpenAI } from 'openai';
export { OpenAI };

// Main class to simplify initialization and configuration
import path from 'path';
import os from 'os';
import { MemoryManager } from './core/MemoryManager.js';
import { Bucket } from './core/Bucket.js';
import { SummarizationEngine } from './summarization/SummarizationEngine.js';
import { GoogleDriveProvider } from './providers/GoogleDriveProvider.js';
import { Chunk, ChunkLocation, ExtractedMemory, MemoryExtractor, MemoryFeedback, Metadata, StorageTier, UserProfileMemory, UserProfilePrivacySettings, UserProfileSnippet, MemoryQuery, ProfileMemory, Vector } from './core/types.js';
import { DeterministicMemoryExtractor } from './core/MemoryExtractor.js';
import { ProfileMemoryExtractor } from './core/ProfileMemoryExtractor.js';
import { PromptCategorizer } from './categorization/PromptCategorizer.js';
import { isRetrievable } from './utils/MemorySafety.js';

/**
 * Main InfiniteContext class that provides a simplified API for using the system
 */
export class InfiniteContext {
  private memoryManager: MemoryManager;
  private summarizationEngine: SummarizationEngine;
  private promptCategorizer?: PromptCategorizer;
  private embeddingFunction?: (text: string) => Promise<Vector>;
  private memoryExtractor: MemoryExtractor;
  private profileExtractor: ProfileMemoryExtractor;
  private embeddingModel?: any;
  private llmModel?: any;

  /**
   * Create a new InfiniteContext instance
   *
   * @param options - Configuration options
   */
  constructor(options: {
    basePath?: string;
    openai?: OpenAI;
    embeddingModel?: string;
    llmModel?: string;
    memoryExtractor?: MemoryExtractor;
    categorizerOptions?: {
      cacheSize?: number;
      cacheExpiration?: number;
      enableLearning?: boolean;
    };
    profileMemory?: Partial<UserProfilePrivacySettings>;
    googleDriveCredentials?: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      refreshToken: string;
    };
  } = {}) {
    const basePath = options.basePath || path.join(os.homedir(), '.infinite-context');

    // Set up the embedding function if OpenAI is provided
    let embeddingFunction: ((text: string) => Promise<Vector>) | undefined;

    if (options.openai) {
      this.embeddingModel = options.embeddingModel || 'text-embedding-3-small';
      this.llmModel = options.llmModel || 'gpt-3.5-turbo';

      embeddingFunction = async (text: string): Promise<Vector> => {
        const response = await options.openai!.embeddings.create({
          model: this.embeddingModel,
          input: text,
        });

        return response.data[0].embedding;
      };
    }
    this.embeddingFunction = embeddingFunction;

    // Create the memory extractor
    this.memoryExtractor = options.memoryExtractor || new DeterministicMemoryExtractor();

    // Create the memory manager
    this.memoryManager = new MemoryManager({
      basePath,
      embeddingFunction
    });

    // Create the summarization engine
    this.summarizationEngine = new SummarizationEngine(options.openai);

    // Create the profile memory extractor for durable user-profile extraction.
    this.profileExtractor = new ProfileMemoryExtractor({ profilePrivacy: options.profileMemory });
    this.memoryManager.setProfilePrivacy(this.profileExtractor.getProfilePrivacy());
  }

  /**
   * Initialize the system
   *
   * @param options - Initialization options
   */
  public async initialize(options: {
    addGoogleDrive?: boolean;
    googleDriveCredentials?: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      refreshToken: string;
    };
    enableMemoryMonitoring?: boolean;
    memoryMonitoringConfig?: Partial<{
      bucketSizeThresholdMB: number;
      providerCapacityThresholdPercent: number;
      domainGrowthThresholdPercent: number;
      monitoringIntervalMs: number;
    }>;
    initializeCategorizer?: boolean;
    categorizerOptions?: {
      cacheSize?: number;
      cacheExpiration?: number;
      enableLearning?: boolean;
    };
  } = {}): Promise<void> {
    // Initialize the memory manager
    await this.memoryManager.initialize();

    // Add Google Drive provider if requested
    if (options.addGoogleDrive && options.googleDriveCredentials) {
      const googleDriveProvider = new GoogleDriveProvider(options.googleDriveCredentials, {
        id: 'gdrive',
        name: 'Google Drive',
      });

      await googleDriveProvider.connect();
      this.memoryManager.addStorageProvider(googleDriveProvider);
    }

    // Start memory monitoring if requested
    if (options.enableMemoryMonitoring) {
      this.memoryManager.startMemoryMonitoring();

      // Add default alert handler that logs to console
      this.memoryManager.addAlertHandler((alert) => {
        console.log(`[InfiniteContext] Memory Alert: ${alert.message}`);
        console.log(`Details: ${JSON.stringify(alert.details)}`);
      });
    }

    // Initialize the prompt categorizer if requested
    if (options.initializeCategorizer !== false && this.memoryManager['embeddingFunction']) {
      const categorizerOptions = options.categorizerOptions || {};

      this.promptCategorizer = new PromptCategorizer(
        this.memoryManager,
        {
          cacheOptions: {
            maxSize: categorizerOptions.cacheSize || 1000,
            expirationMs: categorizerOptions.cacheExpiration || 24 * 60 * 60 * 1000, // 24 hours
          },
          embeddingFunction: this.memoryManager['embeddingFunction'],
          enableLearning: categorizerOptions.enableLearning !== false,
        }
      );
      await this.promptCategorizer.initialize();

      console.log('Prompt categorizer initialized');
    }
  }

  /**
   * Store content in the system
   *
   * @param content - The content to store
   * @param options - Storage options
   * @returns The ID of the created chunk
   */
  public async storeContent(
    content: string,
    options: {
      bucketName?: string;
      bucketDomain?: string;
      metadata?: Partial<Omit<Metadata, 'id' | 'timestamp'>>;
      retentionPolicy?: Metadata['retentionPolicy'];
      expiresAt?: string;
      sensitivity?: Metadata['sensitivity'];
      summarize?: boolean;
      preferredTier?: StorageTier;
      extractProfile?: boolean;
      userId?: string;
      episodeId?: string;
      traceId?: string;
    } = {}
  ): Promise<string> {
    const bucketName = options.bucketName || 'default';
    const bucketDomain = options.bucketDomain || 'general';
    const metadata = options.metadata || {};
    const summarize = options.summarize !== false;
    const preferredTier = options.preferredTier || StorageTier.LOCAL;
    const extractProfile = options.extractProfile === true;

    // Find or create the bucket
    const buckets = this.memoryManager.getBuckets();
    let bucket = Array.from(buckets.values())
      .find(b => b.getName() === bucketName && b.getDomain() === bucketDomain);

    if (!bucket) {
      bucket = this.memoryManager.createBucket({
        name: bucketName,
        domain: bucketDomain,
        description: `Automatically created bucket for ${bucketName} (${bucketDomain})`,
      });
    }

    // Create and store the chunk
    const chunk = await this.memoryManager.createChunk(content, {
      domain: bucketDomain,
      source: 'user-input',
      tags: [],
      retentionPolicy: options.retentionPolicy,
      expiresAt: options.expiresAt,
      sensitivity: options.sensitivity,
      ...metadata,
    }, summarize);

    const traceId = options.traceId || (metadata.traceId as string | undefined);
    let profile: UserProfileMemory | null = null;

    if (extractProfile) {
      profile = this.profileExtractor.extractProfileMemory({
        content,
        userId: options.userId,
        episodeId: options.episodeId || chunk.id,
        traceId,
        timestamp: chunk.metadata.timestamp,
      });

      if (profile) {
        chunk.metadata.profileMemoryIds = [profile.id];
        chunk.metadata.episodeId = options.episodeId || chunk.id;
        if (traceId) {
          chunk.metadata.traceId = traceId;
        }
      }
    }

    // Add the chunk to the bucket
    bucket.addChunk(chunk);

    // Store the chunk in the appropriate storage provider
    await this.memoryManager.storeChunk(chunk, preferredTier);

    if (profile) {
      await this.memoryManager.storeUserProfileMemory(profile, preferredTier);
    }

    return chunk.id;
  }

  /**
   * Retrieve content from the system based on a query
   *
   * @param query - The query to search for
   * @param options - Retrieval options
   * @returns Matching chunks with their relevance scores
   */
  public async retrieveContent(
    query: string,
    options: {
      bucketName?: string;
      bucketDomain?: string;
      maxResults?: number;
      minScore?: number;
      retrievalMode?: 'flat' | 'hierarchical';
      hierarchicalOptions?: import('./core/HierarchicalRetriever.js').HierarchicalRetrieverOptions;
      includeProfiles?: boolean;
      userId?: string;
      maxProfileSnippets?: number;
    } = {}
  ): Promise<Array<{ chunk: Chunk, score: number, profileSnippets?: UserProfileSnippet[] }>> {
    const bucketName = options.bucketName;
    const bucketDomain = options.bucketDomain;
    const maxResults = options.maxResults || 10;
    const minScore = options.minScore || 0.7;
    const retrievalMode = options.retrievalMode || 'flat';
    const profileSnippets = options.includeProfiles
      ? this.memoryManager.getRelevantProfileSnippets(query, {
          userId: options.userId,
          maxSnippets: options.maxProfileSnippets,
        })
      : undefined;

    // Find relevant buckets
    let searchResults: Array<{ chunk: Chunk, score: number }> = [];

    if (bucketName && bucketDomain) {
      // Search in the specific bucket
      const buckets = this.memoryManager.getBuckets();
      const bucket = Array.from(buckets.values())
        .find(b => b.getName() === bucketName && b.getDomain() === bucketDomain);

      if (bucket) {
        const queryVector = await this.getEmbedding(query);
        searchResults = bucket.search(queryVector, maxResults, true);
      }
    } else if (retrievalMode === 'hierarchical') {
      const routedResults = await this.memoryManager.searchMemory(query, {
        ...options.hierarchicalOptions,
        mode: 'hierarchical',
        k: maxResults
      });
      searchResults = routedResults.results.map(({ chunk, score }) => ({ chunk, score }));
    } else {
      // Find the most relevant buckets
      const relevantBuckets = await this.memoryManager.findRelevantBuckets(query, 3);

      // Search in each relevant bucket
      for (const { bucket } of relevantBuckets) {
        const queryVector = await this.getEmbedding(query);
        const results = bucket.search(queryVector, maxResults, true);
        searchResults.push(...results);
      }

      // Sort and limit the results
      searchResults.sort((a, b) => b.score - a.score);
      searchResults = searchResults.slice(0, maxResults);
    }

    // Filter by minimum score and production safety controls (retention/deletion).
    searchResults = searchResults.filter(result => result.score >= minScore && isRetrievable(result.chunk));

    if (profileSnippets && profileSnippets.length > 0) {
      return searchResults.map(result => ({ ...result, profileSnippets }));
    }

    return searchResults;
  }


  /**
   * Record explicit feedback for a stored memory.
   *
   * Approvals increase retrieval weight, neutral feedback gently decays it, and
   * rebuttals mark the memory as stale while keeping it available for audit or
   * future revival instead of deleting it immediately.
   *
   * @param chunkId - The memory chunk ID to update
   * @param feedback - The feedback signal to apply
   * @returns The updated chunk
   */
  public recordMemoryFeedback(chunkId: string, feedback: MemoryFeedback): Chunk {
    const chunk = this.memoryManager.recordMemoryFeedback(chunkId, feedback);
    if (!chunk) {
      throw new Error(`Chunk not found for ID: ${chunkId}`);
    }

    return chunk;
  }

  /**
   * Assemble retrieval results and profile snippets for agent prompts.
   */
  public async assembleAgentContext(
    query: string,
    options: {
      bucketName?: string;
      bucketDomain?: string;
      maxResults?: number;
      minScore?: number;
      userId?: string;
      maxProfileSnippets?: number;
    } = {}
  ): Promise<{
    contentResults: Array<{ chunk: Chunk, score: number }>;
    profileSnippets: UserProfileSnippet[];
  }> {
    const contentResults = await this.retrieveContent(query, {
      bucketName: options.bucketName,
      bucketDomain: options.bucketDomain,
      maxResults: options.maxResults,
      minScore: options.minScore,
    });

    const profileSnippets = this.memoryManager.getRelevantProfileSnippets(query, {
      userId: options.userId,
      maxSnippets: options.maxProfileSnippets,
    });

    return {
      contentResults,
      profileSnippets,
    };
  }

  /**
   * Store or update a user profile memory with retention and sensitivity controls.
   */
  public upsertProfileMemory(memory: Omit<ProfileMemory, 'id' | 'createdAt' | 'updatedAt' | 'retentionPolicy' | 'sensitivity' | 'deletionStatus'> & Partial<Pick<ProfileMemory, 'id' | 'createdAt' | 'retentionPolicy' | 'sensitivity' | 'deletionStatus'>>): ProfileMemory {
    return this.memoryManager.upsertProfileMemory(memory);
  }

  /**
   * List chunk, manual-profile, and extracted-profile memories by user, domain,
   * bucket, tag, or sensitivity. Extracted user profiles are governed by the
   * same surface and surface under `userProfiles`.
   */
  public listMemories(query: MemoryQuery = {}): { chunks: Chunk[]; profileMemories: ProfileMemory[]; userProfiles: UserProfileMemory[] } {
    return this.memoryManager.listMemories(query);
  }

  /**
   * Redact memories by user, domain, bucket, tag, or sensitivity.
   */
  public redactMemories(query: MemoryQuery, reason?: string): { matched: number; changed: number } {
    return this.memoryManager.redactMemories(query, reason);
  }

  /**
   * Export memories with redaction/deletion markers respected.
   */
  public exportMemories(query: MemoryQuery = {}): { chunks: Chunk[]; profileMemories: ProfileMemory[]; userProfiles: UserProfileMemory[] } {
    return this.memoryManager.exportMemories(query);
  }

  /**
   * Mark memories deleted by user, domain, bucket, tag, or sensitivity.
   */
  public deleteMemories(query: MemoryQuery, reason?: string): { matched: number; changed: number } {
    return this.memoryManager.deleteMemories(query, reason);
  }

  /**
   * Summarize a piece of text
   *
   * @param text - The text to summarize
   * @param options - Summarization options
   * @returns The generated summaries
   */
  public async summarize(
    text: string,
    options: {
      levels?: number;
    } = {}
  ): Promise<string[]> {
    const levels = options.levels || 1;

    const summaries = await this.summarizationEngine.summarize(text, levels);

    return summaries.map(summary => summary.content);
  }


  /**
   * Inspect stored profile memories.
   */
  public getUserProfileMemories(userId?: string): UserProfileMemory[] {
    return this.memoryManager.getUserProfileMemories(userId);
  }

  /**
   * Delete one profile memory or all profile memories for a user.
   */
  public async deleteUserProfileMemory(options: { profileId?: string; userId?: string } = {}): Promise<number> {
    return this.memoryManager.deleteUserProfileMemory(options);
  }

  /**
   * Update profile memory privacy settings, including disabling storage.
   */
  public setProfilePrivacy(settings: Partial<UserProfilePrivacySettings>): UserProfilePrivacySettings {
    const extractorSettings = this.profileExtractor.setProfilePrivacy(settings);
    return this.memoryManager.setProfilePrivacy(extractorSettings);
  }

  /**
   * Read current profile memory privacy settings.
   */
  public getProfilePrivacy(): UserProfilePrivacySettings {
    return this.memoryManager.getProfilePrivacy();
  }

  /**
   * Get memory usage statistics
   *
   * @returns Memory usage statistics
   */
  public async getMemoryStats(): Promise<any> {
    return this.memoryManager.getMemoryStats();
  }

  /**
   * Get current memory alerts
   *
   * @param includeAcknowledged - Whether to include acknowledged alerts
   * @returns Array of memory alerts
   */
  public getMemoryAlerts(includeAcknowledged: boolean = false): any[] {
    return this.memoryManager.getMemoryAlerts(includeAcknowledged);
  }

  /**
   * Acknowledge a memory alert
   *
   * @param alertId - The ID of the alert to acknowledge
   * @returns True if the alert was found and acknowledged, false otherwise
   */
  public acknowledgeMemoryAlert(alertId: string): boolean {
    return this.memoryManager.acknowledgeMemoryAlert(alertId);
  }

  /**
   * Add a memory alert handler
   *
   * @param handler - The handler function to add
   */
  public addMemoryAlertHandler(handler: (alert: any) => void): void {
    this.memoryManager.addAlertHandler(handler);
  }

  /**
   * Create a backup of the system
   *
   * @param options - Backup options
   * @returns The backup metadata
   */
  public async createBackup(options: {
    backupPath?: string;
    includeVectorStores?: boolean;
    includeBuckets?: string[];
    excludeBuckets?: string[];
    maxBackups?: number;
  } = {}): Promise<any> {
    const { createBackup } = await import('./utils/BackupManager.js');

    return createBackup({
      basePath: this.memoryManager['basePath'],
      ...options,
    });
  }

  /**
   * Recover from a backup
   *
   * @param options - Recovery options
   * @returns Whether the recovery was successful
   */
  public async recoverFromBackup(options: {
    backupId?: string;
    backupPath?: string;
    targetPath?: string;
    includeBuckets?: string[];
    excludeBuckets?: string[];
    overwriteExisting?: boolean;
  } = {}): Promise<boolean> {
    const { recoverFromBackup } = await import('./utils/BackupManager.js');

    return recoverFromBackup({
      targetPath: this.memoryManager['basePath'],
      ...options,
    });
  }

  /**
   * List available backups
   *
   * @param backupPath - The path to the backups directory
   * @returns The list of backup metadata
   */
  public async listBackups(backupPath?: string): Promise<any[]> {
    const { listBackups } = await import('./utils/BackupManager.js');

    return listBackups(backupPath);
  }

  /**
   * Export chunks to a file
   *
   * @param chunks - The chunks to export
   * @param options - Export options
   * @returns The export result
   */
  public async exportChunks(chunks: Chunk[], options: {
    format?: 'json' | 'jsonl' | 'csv';
    outputPath: string;
    compress?: boolean;
    includeEmbeddings?: boolean;
    includeSummaries?: boolean;
    includeDeleted?: boolean;
  }): Promise<any> {
    const { exportChunks, ExportFormat } = await import('./utils/DataPortability.js');

    // Create a new options object without the format property
    const { format: formatStr, ...restOptions } = options;

    // Convert the format string to the enum value
    let formatEnum: typeof ExportFormat[keyof typeof ExportFormat] | undefined;
    if (formatStr === 'json') formatEnum = ExportFormat.JSON;
    else if (formatStr === 'jsonl') formatEnum = ExportFormat.JSONL;
    else if (formatStr === 'csv') formatEnum = ExportFormat.CSV;

    return exportChunks(chunks, {
      ...restOptions,
      format: formatEnum,
    });
  }

  /**
   * Import chunks from a file
   *
   * @param options - Import options
   * @returns The import result
   */
  public async importChunks(options: {
    inputPath: string;
    bucketName?: string;
    bucketDomain?: string;
    decompress?: boolean;
    generateEmbeddings?: boolean;
    generateSummaries?: boolean;
    preferredTier?: StorageTier;
    summaryLevels?: number;
  }): Promise<any> {
    const { importChunks } = await import('./utils/DataPortability.js');
    return importChunks({
      ...options,
      memoryManager: this.memoryManager,
      embeddingFunction: options.generateEmbeddings ? this.embeddingFunction : undefined,
      summarizationEngine: options.generateSummaries ? this.summarizationEngine : undefined,
    });
  }

  /**
   * Verify the integrity of a chunk
   *
   * @param chunk - The chunk to verify
   * @param storedHash - The stored hash to compare against
   * @returns The verification result
   */
  public async verifyChunkIntegrity(chunk: Chunk, storedHash: string): Promise<any> {
    const { verifyChunk } = await import('./utils/IntegrityVerifier.js');

    return verifyChunk(chunk, storedHash);
  }

  /**
   * Repair a chunk if possible
   *
   * @param chunk - The chunk to repair
   * @param verificationResult - The verification result
   * @returns The repaired chunk, or null if repair is not possible
   */
  public async repairChunk(chunk: Chunk, verificationResult: any): Promise<Chunk | null> {
    const { repairChunk } = await import('./utils/IntegrityVerifier.js');

    return repairChunk(chunk, verificationResult);
  }

  /**
   * Optimize a vector index
   *
   * @param chunks - The chunks in the index
   * @param currentParams - The current index parameters
   * @param options - The optimization options
   * @returns The optimized index parameters
   */
  public async optimizeIndex(chunks: Chunk[], currentParams: any, options: {
    targetMemoryUsage?: number;
    maxIndexSize?: number;
    rebuildThreshold?: number;
  } = {}): Promise<any> {
    const { optimizeIndex } = await import('./utils/IndexManager.js');

    return optimizeIndex(chunks, currentParams, options);
  }

  /**
   * Rebuild a vector index
   *
   * @param chunks - The chunks to include in the index
   * @param params - The index parameters
   * @param outputPath - The path to save the index
   * @returns Whether the rebuild was successful
   */
  public async rebuildIndex(chunks: Chunk[], params: any, outputPath: string): Promise<boolean> {
    const { rebuildIndex } = await import('./utils/IndexManager.js');

    return rebuildIndex(chunks, params, outputPath);
  }

  /**
   * Estimate the memory usage of an index
   *
   * @param params - The index parameters
   * @param size - The number of vectors in the index
   * @returns The estimated memory usage in bytes
   */
  public async estimateIndexMemoryUsage(params: any, size: number): Promise<number> {
    const { estimateMemoryUsage } = await import('./utils/IndexManager.js');

    return estimateMemoryUsage(params, size);
  }

  /**
   * Get the optimal index parameters for a given dataset size and dimension
   *
   * @param size - The number of vectors in the dataset
   * @param dimension - The dimension of the vectors
   * @param memoryBudget - The memory budget in bytes
   * @returns The optimal index parameters
   */
  public async getOptimalIndexParams(size: number, dimension: number, memoryBudget?: number): Promise<any> {
    const { getOptimalIndexParams } = await import('./utils/IndexManager.js');

    return getOptimalIndexParams(size, dimension, memoryBudget);
  }

  /**
   * Store a prompt and its output with automatic categorization
   *
   * @param prompt - The prompt text
   * @param output - The output text
   * @param options - Storage options
   * @returns The ID of the created chunk
   */
  public async storePromptAndOutput(
    prompt: string,
    output: string,
    options: {
      metadata?: Partial<Omit<Metadata, 'id' | 'timestamp'>>;
      summarize?: boolean;
      preferredTier?: StorageTier;
      extractProfile?: boolean;
      userId?: string;
      episodeId?: string;
      traceId?: string;
      overrideBucket?: { name: string, domain: string };
    } = {}
  ): Promise<string> {
    // Ensure the categorizer is initialized
    if (!this.promptCategorizer) {
      throw new Error('Prompt categorizer is not initialized. Call initialize() with initializeCategorizer: true first.');
    }

    // Use the categorizer to find the best bucket
    const categorization = await this.promptCategorizer.categorize(prompt, output);
    const timestamp = new Date().toISOString();

    // Extract structured memory before storage so the episode can be routed into
    // domain/category/trace hierarchy nodes instead of a flat categorization bucket.
    const extractedMemory = await this.memoryExtractor.extractMemory({
      prompt,
      output,
      timestamp,
      metadata: {
        ...options.metadata,
        domain: options.overrideBucket?.domain || options.metadata?.domain || categorization.bucketDomain,
        bucketName: options.overrideBucket?.name || categorization.bucketName,
        category: options.overrideBucket?.name || categorization.bucketName
      }
    });

    if (!extractedMemory) {
      throw new Error('Memory extractor did not return an extracted memory payload.');
    }

    const finalMemory: ExtractedMemory = {
      ...extractedMemory,
      domain: options.overrideBucket?.domain || extractedMemory.domain,
      category: options.overrideBucket?.name || extractedMemory.category,
      timestamp: extractedMemory.timestamp || timestamp
    };
    const traceBucket = this.resolveMemoryTraceBucket(finalMemory);
    const summarize = options.summarize !== false;
    const preferredTier = options.preferredTier || StorageTier.LOCAL;

    // Create and store the episode-level chunk under the resolved trace node.
    const chunk = await this.memoryManager.createChunk(finalMemory.episodeText, {
      domain: finalMemory.domain,
      source: 'prompt-output-memory-extraction',
      tags: [finalMemory.category, finalMemory.memoryTrace],
      ...options.metadata,
      prompt,
      output,
      extractedMemory: finalMemory,
      memoryHierarchy: {
        domain: finalMemory.domain,
        category: finalMemory.category,
        trace: finalMemory.memoryTrace
      },
      categorization: {
        confidence: categorization.confidence,
        strategy: categorization.strategy,
        automatic: !options.overrideBucket
      }
    }, summarize);

    traceBucket.addChunk(chunk);
    await this.memoryManager.storeChunk(chunk, preferredTier);

    // If there was a manual override, record it as feedback
    if (options.overrideBucket) {
      this.promptCategorizer.recordFeedback(
        prompt,
        output,
        `${categorization.bucketName}/${categorization.bucketDomain}`,
        `${options.overrideBucket.name}/${options.overrideBucket.domain}`
      );
    }

    return chunk.id;
  }

  /**
   * Resolve or create the hierarchy for an extracted memory.
   *
   * The hierarchy is: domain root bucket -> category sub-bucket -> memory trace
   * sub-bucket. Episode chunks are stored on the trace bucket.
   */
  private resolveMemoryTraceBucket(memory: ExtractedMemory): Bucket {
    const domainBucket = this.findOrCreateRootBucket(
      memory.domain,
      memory.domain,
      `Memory domain: ${memory.domain}`
    );
    const categoryBucket = this.findOrCreateSubBucket(
      domainBucket,
      memory.category,
      memory.domain,
      `Memory category: ${memory.category}`
    );

    return this.findOrCreateSubBucket(
      categoryBucket,
      memory.memoryTrace,
      memory.domain,
      `Memory trace: ${memory.memoryTrace}`
    );
  }

  private findOrCreateRootBucket(name: string, domain: string, description: string): Bucket {
    const existingBucket = Array.from(this.memoryManager.getBuckets().values())
      .find(bucket => bucket.getName() === name && bucket.getDomain() === domain);

    return existingBucket || this.memoryManager.createBucket({
      name,
      domain,
      description
    });
  }

  private findOrCreateSubBucket(parent: Bucket, name: string, domain: string, description: string): Bucket {
    const existingBucket = Array.from(parent.getSubBuckets().values())
      .find(bucket => bucket.getName() === name && bucket.getDomain() === domain);

    return existingBucket || parent.addSubBucket({
      name,
      domain,
      description
    });
  }

  /**
   * Update the categorizer with the latest buckets
   *
   * @returns Promise that resolves when the update is complete
   */
  public async updateCategorizer(): Promise<void> {
    if (!this.promptCategorizer) {
      throw new Error('Prompt categorizer is not initialized. Call initialize() with initializeCategorizer: true first.');
    }

    await this.promptCategorizer.updateCategories();
  }

  /**
   * Get the embedding for a piece of text
   *
   * @param text - The text to embed
   * @returns The embedding vector
   */
  private async getEmbedding(text: string): Promise<Vector> {
    if (!this.memoryManager['embeddingFunction']) {
      throw new Error('No embedding function available');
    }

    return this.memoryManager['embeddingFunction'](text);
  }
}
