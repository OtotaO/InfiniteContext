import { v4 as uuidv4 } from 'uuid';
import { Vector, Chunk, SearchResult, BucketConfig, MemoryFeedback, ChunkSummary, HierarchyLevel } from './types.js';
import { VectorStore } from './VectorStore.js';

/**
 * Bucket class for organizing chunks into domains and hierarchies.
 *
 * Buckets can contain chunks and sub-buckets, forming a hierarchical structure
 * for organizing information by domain, topic, or any other classification.
 */
export class Bucket {
  private id: string;
  private name: string;
  private domain: string;
  private description?: string;
  private vectorStore: VectorStore;
  private subBuckets: Map<string, Bucket> = new Map();
  private parentId?: string;
  private onChange?: () => void;

  /**
   * Create a new Bucket
   *
   * @param config - The bucket configuration
   * @param vectorStore - Optional vector store to use (will create one if not provided)
   * @param onChange - Optional callback invoked when bucket contents or hierarchy change
   */
  constructor(config: BucketConfig, vectorStore?: VectorStore, onChange?: () => void) {
    this.id = config.id || uuidv4();
    this.name = config.name;
    this.domain = config.domain;
    this.description = config.description;
    this.parentId = config.parentId;
    this.vectorStore = vectorStore || new VectorStore();
    this.onChange = onChange;
  }

  /**
   * Get the bucket ID
   */
  public getId(): string {
    return this.id;
  }

  /**
   * Get the bucket name
   */
  public getName(): string {
    return this.name;
  }

  /**
   * Get the bucket domain
   */
  public getDomain(): string {
    return this.domain;
  }

  /**
   * Get the bucket description
   */
  public getDescription(): string | undefined {
    return this.description;
  }

  /**
   * Get this bucket's configuration for persistence.
   */
  public getConfig(): BucketConfig {
    return {
      id: this.id,
      name: this.name,
      domain: this.domain,
      description: this.description,
      parentId: this.parentId
    };
  }

  /**
   * Get the parent bucket ID
   */
  public getParentId(): string | undefined {
    return this.parentId;
  }

  /**
   * Add a chunk to the bucket
   *
   * @param chunk - The chunk to add
   * @returns The ID of the chunk in the vector store
   */
  public addChunk(chunk: Chunk): number {
    // Ensure the chunk has the correct domain and bucket identifiers
    chunk.metadata.domain = this.domain;
    chunk.metadata.bucket = this.name;
    chunk.metadata.bucketId = this.id;
    chunk.metadata.bucketName = this.name;
    this.prepareChunkForHierarchy(chunk);
    const id = this.vectorStore.addChunk(chunk);
    this.onChange?.();
    return id;
  }

  /**
   * Add multiple chunks to the bucket
   *
   * @param chunks - The chunks to add
   * @returns The IDs of the chunks in the vector store
   */
  public addChunks(chunks: Chunk[]): number[] {
    for (const chunk of chunks) {
      chunk.metadata.bucket = this.name;
      chunk.metadata.bucketId = this.id;
      chunk.metadata.bucketName = this.name;
      this.prepareChunkForHierarchy(chunk);
    }
    const ids = this.vectorStore.addChunks(chunks);
    this.onChange?.();
    return ids;
  }

  /**
   * Search for chunks in the bucket
   *
   * @param queryVector - The query vector
   * @param k - The number of results to return
   * @param recursive - Whether to search in sub-buckets
   * @returns The search results
   */
  public search(queryVector: Vector, k: number = 10, recursive: boolean = true): SearchResult[] {
    let results = this.vectorStore.search(queryVector, k);

    if (recursive && this.subBuckets.size > 0) {
      // Get results from all sub-buckets
      const subResults: SearchResult[] = [];
      for (const subBucket of this.subBuckets.values()) {
        subResults.push(...subBucket.search(queryVector, k, true));
      }

      // Combine results
      results = [...results, ...subResults];

      // Sort by score
      results.sort((a, b) => b.score - a.score);

      // Limit to k results
      if (results.length > k) {
        results = results.slice(0, k);
      }
    }

    return results;
  }


  /**
   * Record explicit user feedback for a chunk in this bucket or sub-buckets.
   *
   * @param chunkId - The chunk ID to update
   * @param feedback - User feedback to apply to memory weight/lifecycle
   * @param recursive - Whether to search sub-buckets
   * @returns The updated chunk, or undefined if not found
   */
  public recordMemoryFeedback(
    chunkId: string,
    feedback: MemoryFeedback,
    recursive: boolean = true
  ): Chunk | undefined {
    const chunk = this.vectorStore.recordMemoryFeedback(chunkId, feedback);
    if (chunk || !recursive) {
      return chunk;
    }

    for (const subBucket of this.subBuckets.values()) {
      const subChunk = subBucket.recordMemoryFeedback(chunkId, feedback, true);
      if (subChunk) {
        return subChunk;
      }
    }

    return undefined;
  }

  /**
   * Add a sub-bucket
   *
   * @param config - The sub-bucket configuration
   * @returns The created sub-bucket
   */
  public addSubBucket(config: Omit<BucketConfig, 'id' | 'parentId'> & Partial<Pick<BucketConfig, 'id'>>): Bucket {
    const fullConfig: BucketConfig = {
      id: config.id || uuidv4(),
      ...config,
      parentId: this.id
    };
    const subBucket = new Bucket(fullConfig, undefined, this.onChange);
    this.subBuckets.set(subBucket.getId(), subBucket);
    this.onChange?.();

    return subBucket;
  }

  /**
   * Attach an existing bucket as a sub-bucket. Used when rebuilding persisted hierarchies.
   *
   * @param bucket - The bucket to attach
   */
  public addExistingSubBucket(bucket: Bucket): void {
    this.subBuckets.set(bucket.getId(), bucket);
    this.onChange?.();
  }

  /**
   * Get chunks stored directly in this bucket, excluding sub-buckets.
   */
  public getChunks(): Chunk[] {
    return this.vectorStore.getChunks();
  }

  /**
   * Get a sub-bucket by ID
   *
   * @param id - The sub-bucket ID
   * @returns The sub-bucket, or undefined if not found
   */
  public getSubBucket(id: string): Bucket | undefined {
    return this.subBuckets.get(id);
  }

  /**
   * Remove a sub-bucket
   *
   * @param id - The sub-bucket ID
   * @returns True if the sub-bucket was removed, false if not found
   */
  public removeSubBucket(id: string): boolean {
    const removed = this.subBuckets.delete(id);
    if (removed) {
      this.onChange?.();
    }
    return removed;
  }

  /**
   * Get all sub-buckets
   *
   * @returns A map of sub-bucket IDs to sub-buckets
   */
  public getSubBuckets(): Map<string, Bucket> {
    return new Map(this.subBuckets);
  }

  /**
   * Get a flat array of all chunks in this bucket and optionally sub-buckets
   *
   * @param recursive - Whether to include chunks from sub-buckets
   * @param includeDeleted - Whether to include chunks marked as deleted
   * @returns An array of chunks
   */
  public getAllChunks(recursive: boolean = true, includeDeleted: boolean = false): Chunk[] {
    // Use the vector store's defensive-copy accessor so callers cannot mutate
    // internal store state through returned chunk references.
    const chunks: Chunk[] = this.vectorStore.getAllChunks(includeDeleted);

    // Add chunks from sub-buckets if recursive
    if (recursive) {
      for (const subBucket of this.subBuckets.values()) {
        chunks.push(...subBucket.getAllChunks(true, includeDeleted));
      }
    }

    return chunks;
  }


  /**
   * Update a chunk stored in this bucket or any descendant bucket.
   */
  public updateChunk(chunk: Chunk, recursive: boolean = true): boolean {
    if (this.vectorStore.updateChunk(chunk)) {
      return true;
    }

    if (recursive) {
      for (const subBucket of this.subBuckets.values()) {
        if (subBucket.updateChunk(chunk, true)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get the total number of chunks in this bucket and optionally sub-buckets
   *
   * @param recursive - Whether to include chunks from sub-buckets
   * @returns The number of chunks
   */
  public getChunkCount(recursive: boolean = true): number {
    let count = this.vectorStore.size();

    if (recursive) {
      for (const subBucket of this.subBuckets.values()) {
        count += subBucket.getChunkCount(true);
      }
    }

    return count;
  }

  /**
   * Get chunks held directly in this bucket, without traversing sub-buckets.
   */
  public getDirectChunks(): Chunk[] {
    return this.vectorStore.getChunks();
  }

  /**
   * Add H-MEM compatible hierarchy pointers to episode-level chunks.
   */
  private prepareChunkForHierarchy(chunk: Chunk): void {
    chunk.metadata.domain = this.domain;
    chunk.metadata.hierarchyLevel = HierarchyLevel.EPISODE;
    chunk.metadata.childIds = chunk.metadata.childIds || [];

    const category = (chunk.metadata.category as string | undefined) || chunk.metadata.tags[0] || 'uncategorized';
    const traceId = (chunk.metadata.memoryTraceId as string | undefined)
      || (chunk.metadata.traceId as string | undefined)
      || (chunk.metadata.source as string | undefined)
      || 'default-trace';

    chunk.hierarchy = {
      level: HierarchyLevel.EPISODE,
      parentId: `${this.domain}/${category}/${traceId}`,
      childIds: [],
      path: [this.domain, category, traceId, chunk.id]
    };
  }

  /**
   * Generate a summary of this bucket's contents
   *
   * @param maxChunks - The maximum number of chunks to include in the summary
   * @returns A summary of the bucket's contents
   */
  public summarize(maxChunks: number = 10): string {
    const chunks = this.getAllChunks();
    const chunkCount = chunks.length;

    // If there are no chunks, return a simple summary
    if (chunkCount === 0) {
      return `Bucket "${this.name}" (${this.domain}) contains no chunks.`;
    }

    // Get the most recent chunks
    chunks.sort((a, b) =>
      new Date(b.metadata.timestamp).getTime() - new Date(a.metadata.timestamp).getTime()
    );

    const recentChunks = chunks.slice(0, maxChunks);

    // Extract summaries from chunks
    const summaries = recentChunks.flatMap(chunk =>
      chunk.summaries
        .filter(summary => summary.level === 1) // Use highest-level summaries
        .map(summary => summary.content)
    );

    // Combine into a single summary
    return `Bucket "${this.name}" (${this.domain}) contains ${chunkCount} chunks.
Recent content includes: ${summaries.join(' ')}`;
  }
}
