import { promises as fs } from 'fs';
import { dirname } from 'path';
import { Vector, SearchResult, Chunk, MemoryFeedback, MemoryMetadata } from './types.js';

/**
 * Simple in-memory vector store implementation with basic search functionality.
 * This implementation uses brute-force search with cosine similarity, which is
 * not as efficient as HNSW but doesn't require native dependencies.
 */
export class VectorStore {
  private static readonly DEFAULT_MEMORY_WEIGHT = 1;
  private static readonly DEFAULT_DECAY_RATE = 0.01;
  private static readonly MIN_MEMORY_WEIGHT = 0.05;
  private static readonly STALE_MEMORY_MULTIPLIER = 0.25;
  private static readonly DAY_MS = 24 * 60 * 60 * 1000;

  private dimension: number;
  private metric: 'cosine' | 'euclidean' | 'dot';
  private chunks: Chunk[] = [];
  private dirty = false;
  private path?: string;

  /**
   * Create a new VectorStore instance
   *
   * @param dimension - The dimensionality of vectors to be stored
   * @param metric - The distance metric to use ('cosine', 'euclidean', or 'dot')
   * @param path - Optional path for persistence
   */
  constructor(
    dimension: number = 1536,
    metric: 'cosine' | 'euclidean' | 'dot' = 'cosine',
    path?: string
  ) {
    this.dimension = dimension;
    this.metric = metric;
    this.path = path;
  }

  /**
   * Normalize a vector to unit length (L2 norm)
   */
  private normalizeVector(vector: Vector): Vector {
    if (this.metric !== 'cosine') return vector;

    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (norm === 0) return vector;
    return vector.map(val => val / norm);
  }

  /**
   * Calculate the distance between two vectors based on the metric
   */
  private calculateDistance(a: Vector, b: Vector): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same dimension');
    }

    switch (this.metric) {
      case 'cosine': {
        // For cosine similarity, we use the dot product of normalized vectors
        const normA = this.normalizeVector(a);
        const normB = this.normalizeVector(b);
        return normA.reduce((sum, val, i) => sum + val * normB[i], 0);
      }
      case 'euclidean': {
        // For Euclidean distance, smaller is better
        const sum = a.reduce((sum, val, i) => sum + Math.pow(val - b[i], 2), 0);
        return -Math.sqrt(sum); // Negate so that higher values are better
      }
      case 'dot': {
        // Dot product, higher is better
        return a.reduce((sum, val, i) => sum + val * b[i], 0);
      }
      default:
        throw new Error(`Unsupported metric: ${this.metric}`);
    }
  }

  /**
   * Ensure older persisted chunks have lifecycle metadata.
   */
  private ensureMemoryMetadata(chunk: Chunk, now: Date = new Date()): MemoryMetadata {
    if (!chunk.memory) {
      chunk.memory = {
        weight: VectorStore.DEFAULT_MEMORY_WEIGHT,
        lastAccessedAt: chunk.metadata.timestamp || now.toISOString(),
        accessCount: 0,
        decayRate: VectorStore.DEFAULT_DECAY_RATE,
      };
    }

    chunk.memory.weight = typeof chunk.memory.weight === 'number'
      ? chunk.memory.weight
      : VectorStore.DEFAULT_MEMORY_WEIGHT;
    chunk.memory.lastAccessedAt = chunk.memory.lastAccessedAt || chunk.metadata.timestamp || now.toISOString();
    chunk.memory.accessCount = typeof chunk.memory.accessCount === 'number'
      ? chunk.memory.accessCount
      : 0;
    chunk.memory.decayRate = typeof chunk.memory.decayRate === 'number'
      ? chunk.memory.decayRate
      : VectorStore.DEFAULT_DECAY_RATE;

    return chunk.memory;
  }

  /**
   * Calculate an effective retrieval weight with exponential time decay.
   */
  private getEffectiveMemoryWeight(chunk: Chunk, now: Date = new Date()): number {
    const memory = this.ensureMemoryMetadata(chunk, now);
    const lastAccessedAt = Date.parse(memory.lastAccessedAt);
    const elapsedDays = Number.isNaN(lastAccessedAt)
      ? 0
      : Math.max(0, (now.getTime() - lastAccessedAt) / VectorStore.DAY_MS);
    const decayedWeight = memory.weight * Math.exp(-memory.decayRate * elapsedDays);
    const lifecycleMultiplier = memory.invalidatedAt ? VectorStore.STALE_MEMORY_MULTIPLIER : 1;

    return Math.max(VectorStore.MIN_MEMORY_WEIGHT, decayedWeight * lifecycleMultiplier);
  }

  /**
   * Blend vector similarity with decayed memory confidence/lifecycle weight.
   */
  private calculateRetrievalScore(queryVector: Vector, chunk: Chunk, now: Date = new Date()): number {
    const semanticScore = this.calculateDistance(queryVector, chunk.embedding);
    return semanticScore * this.getEffectiveMemoryWeight(chunk, now);
  }

  /**
   * Mark a chunk as accessed after retrieval.
   */
  private recordChunkAccess(chunk: Chunk, now: Date = new Date()): void {
    const memory = this.ensureMemoryMetadata(chunk, now);
    memory.lastAccessedAt = now.toISOString();
    memory.accessCount += 1;
    this.dirty = true;
  }

  /**
   * Add a chunk to the vector store
   *
   * @param chunk - The chunk to add
   * @returns The internal ID assigned to the chunk
   */
  public addChunk(chunk: Chunk): number {
    // Make sure the embedding is normalized if using cosine similarity
    if (this.metric === 'cosine') {
      chunk.embedding = this.normalizeVector([...chunk.embedding]);
    }

    this.ensureMemoryMetadata(chunk);

    this.chunks.push(chunk);
    this.dirty = true;
    return this.chunks.length - 1;
  }

  /**
   * Add multiple chunks to the vector store
   *
   * @param chunks - The chunks to add
   * @returns The internal IDs assigned to the chunks
   */
  public addChunks(chunks: Chunk[]): number[] {
    return chunks.map(chunk => this.addChunk(chunk));
  }

  /**
   * Search for chunks similar to the query vector
   *
   * @param queryVector - The query vector
   * @param k - The number of results to return
   * @returns The search results, sorted by similarity
   */
  public search(queryVector: Vector, k: number = 10): SearchResult[] {
    if (this.chunks.length === 0) {
      return [];
    }

    const now = new Date();

    // Calculate scores from semantic similarity and decayed memory weight.
    const results = this.chunks.map((chunk, id) => ({
      chunk,
      score: this.calculateRetrievalScore(queryVector, chunk, now),
      id
    }));

    // Sort by score (descending)
    results.sort((a, b) => b.score - a.score);

    // Return top k results and record access on surfaced memories.
    return results.slice(0, k).map(({ chunk, score }) => {
      this.recordChunkAccess(chunk, now);
      return { chunk, score };
    });
  }

  /**
   * Find a chunk by its public ID.
   */
  public getChunk(chunkId: string): Chunk | undefined {
    const chunk = this.chunks.find(candidate => candidate.id === chunkId);
    if (chunk) {
      this.ensureMemoryMetadata(chunk);
    }
    return chunk;
  }

  /**
   * Record explicit user feedback for a memory without deleting rebutted content.
   */
  public recordMemoryFeedback(chunkId: string, feedback: MemoryFeedback): Chunk | undefined {
    const chunk = this.getChunk(chunkId);
    if (!chunk) {
      return undefined;
    }

    const now = new Date();
    const memory = this.ensureMemoryMetadata(chunk, now);

    switch (feedback) {
      case 'approve':
        memory.weight = Math.min(2, memory.weight + 0.15);
        delete memory.invalidatedAt;
        break;
      case 'neutral':
        memory.weight = Math.max(VectorStore.MIN_MEMORY_WEIGHT, memory.weight * 0.98);
        break;
      case 'rebut':
        memory.weight = Math.max(VectorStore.MIN_MEMORY_WEIGHT, memory.weight * 0.35);
        memory.invalidatedAt = now.toISOString();
        break;
      default:
        throw new Error(`Unsupported feedback: ${feedback}`);
    }

    memory.lastAccessedAt = now.toISOString();
    this.dirty = true;
    return chunk;
  }

  /**
   * Get all chunks in insertion order.
   */
  public getAllChunks(): Chunk[] {
    return this.chunks.map(chunk => {
      this.ensureMemoryMetadata(chunk);
      return chunk;
    });
  }

  /**
   * Get the number of chunks in the store
   */
  public size(): number {
    return this.chunks.length;
  }

  /**
   * Save the vector store to a file
   */
  public async save(path?: string): Promise<void> {
    const savePath = path || this.path;
    if (!savePath) {
      throw new Error('No path specified for saving');
    }

    // Create directory if it doesn't exist
    await fs.mkdir(dirname(savePath), { recursive: true });

    // Save chunks
    await fs.writeFile(
      `${savePath}.json`,
      JSON.stringify(this.chunks),
      'utf-8'
    );

    this.dirty = false;
  }

  /**
   * Load the vector store from a file
   */
  public async load(path?: string): Promise<void> {
    const loadPath = path || this.path;
    if (!loadPath) {
      throw new Error('No path specified for loading');
    }

    try {
      // Load chunks
      const chunksData = await fs.readFile(
        `${loadPath}.json`,
        'utf-8'
      );
      this.chunks = JSON.parse(chunksData) as Chunk[];
      this.chunks.forEach(chunk => this.ensureMemoryMetadata(chunk));
      this.dirty = false;
    } catch (error) {
      throw new Error(`Failed to load vector store: ${error}`);
    }
  }
}
