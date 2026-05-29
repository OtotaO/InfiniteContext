import { promises as fs } from 'fs';
import { dirname } from 'path';
import { Vector, SearchResult, Chunk } from './types.js';
import { indexManager, IndexType } from '../utils/IndexManager.js';

/**
 * Simple in-memory vector store implementation with basic search functionality.
 *
 * The first functional release uses exact flat indexing. Save operations persist
 * both the chunk payload and a real flat index artifact used by index-management
 * utilities. Approximate backends such as HNSW are intentionally unsupported
 * until they are wired into every rebuild, merge, split, save, and load path.
 */
export class VectorStore {
  private dimension: number;
  private metric: 'cosine' | 'euclidean' | 'dot';
  private chunks: Chunk[] = [];
  private dirty = false;
  private path?: string;

  private getIndexPath(basePath: string): string {
    return `${basePath}.index.json`;
  }

  private async persistIndexArtifact(basePath: string): Promise<void> {
    const indexBuilt = await indexManager.rebuildIndex(
      this.chunks,
      {
        type: IndexType.FLAT,
        dimension: this.dimension,
        metric: this.metric,
      },
      this.getIndexPath(basePath)
    );

    if (!indexBuilt) {
      throw new Error('Failed to persist vector store index artifact');
    }
  }

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
  private validateDimension(vector: Vector, label: string): void {
    if (vector.length !== this.dimension) {
      throw new Error(
        `${label} dimension mismatch: expected ${this.dimension}, received ${vector.length}`
      );
    }
  }

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
   * Create a defensive copy of a chunk so callers cannot mutate the store's
   * internal state through returned chunk references.
   */
  private cloneChunk(chunk: Chunk): Chunk {
    return {
      ...chunk,
      embedding: [...chunk.embedding],
      metadata: {
        ...chunk.metadata,
        tags: [...chunk.metadata.tags],
      },
      summaries: chunk.summaries.map(summary => ({
        ...summary,
        concepts: [...summary.concepts],
      })),
    };
  }

  /**
   * Add a chunk to the vector store
   * 
   * @param chunk - The chunk to add
   * @returns The internal ID assigned to the chunk
   */
  public addChunk(chunk: Chunk): number {
    this.validateDimension(chunk.embedding, 'Chunk embedding');

    const storedChunk = this.cloneChunk(chunk);

    // Make sure the embedding is normalized if using cosine similarity
    if (this.metric === 'cosine') {
      storedChunk.embedding = this.normalizeVector(storedChunk.embedding);
    }
    
    this.chunks.push(storedChunk);
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
   * Get every chunk in insertion order.
   *
   * Returned chunks are defensive copies, so mutating them will not affect the
   * chunks held by this vector store.
   *
   * @returns A copy of all stored chunks
   */
  public getAllChunks(): Chunk[] {
    return this.chunks.map(chunk => this.cloneChunk(chunk));
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

    this.validateDimension(queryVector, 'Query vector');

    // Calculate distances
    const results = this.chunks.map((chunk, id) => ({
      chunk,
      score: this.calculateDistance(queryVector, chunk.embedding),
      id
    }));

    // Sort by score (descending)
    results.sort((a, b) => b.score - a.score);

    // Return top k results
    return results.slice(0, k).map(({ chunk, score }) => ({ chunk, score }));
  }

  /**
   * Get a copy of all chunks in insertion order.
   */
  public getChunks(): Chunk[] {
    return [...this.chunks];
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
      JSON.stringify(this.chunks, null, 2),
      'utf-8'
    );

    await this.persistIndexArtifact(savePath);

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
      this.chunks = JSON.parse(chunksData);

      for (const chunk of this.chunks) {
        if (chunk.embedding.length !== this.dimension) {
          throw new Error(`Loaded chunk ${chunk.id} embedding dimension ${chunk.embedding.length} does not match store dimension ${this.dimension}`);
        }
      }

      try {
        const artifact = await indexManager.loadFlatIndex(this.getIndexPath(loadPath));
        if (artifact.params.dimension !== this.dimension || artifact.params.metric !== this.metric || artifact.size !== this.chunks.length) {
          await this.persistIndexArtifact(loadPath);
        }
      } catch {
        await this.persistIndexArtifact(loadPath);
      }

      this.dirty = false;
    } catch (error) {
      throw new Error(`Failed to load vector store: ${error}`);
    }
  }
}
