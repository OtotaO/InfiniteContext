/**
 * Index management utilities for InfiniteContext
 *
 * The first functional release intentionally supports only a persisted flat
 * index. Approximate backends (HNSW/IVF) are not wired into runtime paths yet;
 * callers that request them receive an explicit failure instead of a fake
 * success value.
 */

import fs from 'fs';
import path from 'path';
import { Chunk } from '../core/types.js';
import { errorHandler, VectorStoreError, ErrorCodes } from './ErrorHandler.js';

/**
 * Index type
 */
export enum IndexType {
  FLAT = 'flat',
  /** Reserved for a future approximate backend; not supported in this release. */
  HNSW = 'hnsw',
  /** Reserved for a future approximate backend; not supported in this release. */
  IVF = 'ivf',
}

/**
 * Index parameters
 */
export interface IndexParams {
  type: IndexType;
  dimension: number;
  metric?: 'cosine' | 'euclidean' | 'dot';
  /** Reserved for a future HNSW backend; ignored unless HNSW is implemented. */
  efConstruction?: number;
  /** Reserved for a future HNSW backend; ignored unless HNSW is implemented. */
  M?: number;
  /** Reserved for a future IVF backend; ignored unless IVF is implemented. */
  nlist?: number;
  /** Reserved for a future IVF backend; ignored unless IVF is implemented. */
  nprobe?: number;
}

/**
 * Index statistics
 */
export interface IndexStats {
  type: IndexType;
  dimension: number;
  metric: string;
  size: number;
  memoryUsage: number;
  parameters: Record<string, any>;
}

/**
 * Index optimization options
 */
export interface OptimizationOptions {
  targetMemoryUsage?: number;
  maxIndexSize?: number;
  rebuildThreshold?: number;
}

interface FlatIndexEntry {
  id: string;
  position: number;
  embedding: number[];
}

export interface FlatIndexArtifact {
  schemaVersion: 1;
  backend: IndexType.FLAT;
  params: Required<Pick<IndexParams, 'type' | 'dimension' | 'metric'>>;
  size: number;
  entries: FlatIndexEntry[];
  chunks: Chunk[];
  createdAt: string;
}

/**
 * Index manager for vector index optimization.
 *
 * Only flat/exact indexing is currently implemented. Approximate index types
 * are deliberately rejected by rebuild, merge, split, and memory-estimation
 * paths until a real backend is added.
 */
export class IndexManager {
  private static instance: IndexManager;

  private constructor() {
    // Private constructor to enforce singleton pattern
  }

  public static getInstance(): IndexManager {
    if (!IndexManager.instance) {
      IndexManager.instance = new IndexManager();
    }
    return IndexManager.instance;
  }

  /**
   * Get the optimal index parameters for a given dataset size and dimension.
   *
   * The first functional release only supports flat/exact indexes. This method
   * therefore never recommends HNSW or IVF, regardless of dataset size or
   * memory budget.
   *
   * @param size - The number of vectors in the dataset
   * @param dimension - The dimension of the vectors
   * @param memoryBudget - Reserved for future approximate backends
   * @returns The optimal supported index parameters
   */
  public getOptimalIndexParams(size: number, dimension: number, memoryBudget?: number): IndexParams {
    void size;
    void memoryBudget;

    return {
      type: IndexType.FLAT,
      dimension,
      metric: 'cosine',
    };
  }

  /**
   * Estimate the memory usage of a supported index.
   *
   * @param params - The index parameters
   * @param size - The number of vectors in the index
   * @returns The estimated memory usage in bytes
   */
  public estimateMemoryUsage(params: IndexParams, size: number): number {
    this.assertSupportedParams(params);
    return size * params.dimension * 4;
  }

  /**
   * Check if an index needs optimization.
   *
   * @param stats - The current index statistics
   * @param options - The optimization options
   * @returns Whether the index needs optimization
   */
  public needsOptimization(stats: IndexStats, options: OptimizationOptions = {}): boolean {
    // Check if the index is too large
    if (options.maxIndexSize && stats.size > options.maxIndexSize) {
      return true;
    }

    // Check if the index is using too much memory
    if (options.targetMemoryUsage && stats.memoryUsage > options.targetMemoryUsage) {
      return true;
    }

    // Check if the index has too many deleted vectors
    if (options.rebuildThreshold && stats.parameters.deletedCount > stats.size * options.rebuildThreshold) {
      return true;
    }

    return false;
  }

  /**
   * Optimize an index.
   *
   * @param chunks - The chunks in the index
   * @param currentParams - The current index parameters
   * @param options - The optimization options
   * @returns The optimized index parameters
   */
  public optimizeIndex(chunks: Chunk[], currentParams: IndexParams, options: OptimizationOptions = {}): IndexParams {
    try {
      this.assertSupportedParams(currentParams);

      // Get the current index size
      const size = chunks.length;

      // If the index is empty, return the current parameters
      if (size === 0) {
        return currentParams;
      }

      // Get the dimension from the first chunk
      const dimension = chunks[0].embedding.length;

      // Estimate the current memory usage
      const currentMemoryUsage = this.estimateMemoryUsage(currentParams, size);

      // Check if optimization is needed
      const currentStats: IndexStats = {
        type: currentParams.type,
        dimension,
        metric: currentParams.metric || 'cosine',
        size,
        memoryUsage: currentMemoryUsage,
        parameters: {
          ...currentParams,
          deletedCount: 0,
        },
      };

      if (!this.needsOptimization(currentStats, options)) {
        return currentParams;
      }

      // The only supported optimized backend is still flat/exact.
      return this.getOptimalIndexParams(size, dimension, options.targetMemoryUsage);
    } catch (error) {
      errorHandler.handleError(
        new VectorStoreError(`Index optimization failed: ${(error as Error).message}`, {
          code: ErrorCodes.VECTOR_STORE_INITIALIZATION_FAILED,
          details: {
            error,
          },
          recoverable: true,
        })
      );

      // Return the current parameters if optimization fails
      return currentParams;
    }
  }

  /**
   * Rebuild a flat index artifact from chunks.
   *
   * @param chunks - The chunks to include in the index
   * @param params - The index parameters
   * @param outputPath - The path to save the index artifact
   * @returns Whether the rebuild was successful
   */
  public async rebuildIndex(chunks: Chunk[], params: IndexParams, outputPath: string): Promise<boolean> {
    try {
      this.assertSupportedParams(params);
      this.assertChunkDimensions(chunks, params.dimension);

      const artifact = this.createFlatArtifact(chunks, params);
      await this.writeArtifact(outputPath, artifact);

      return true;
    } catch (error) {
      errorHandler.handleError(
        new VectorStoreError(`Index rebuild failed: ${(error as Error).message}`, {
          code: ErrorCodes.VECTOR_STORE_INITIALIZATION_FAILED,
          details: {
            outputPath,
            error,
          },
          recoverable: false,
        })
      );

      return false;
    }
  }

  /**
   * Merge multiple flat index artifacts.
   *
   * @param indexPaths - The paths to the indices to merge
   * @param outputPath - The path to save the merged index artifact
   * @param params - The index parameters for the merged index
   * @returns Whether the merge was successful
   */
  public async mergeIndices(indexPaths: string[], outputPath: string, params: IndexParams): Promise<boolean> {
    try {
      this.assertSupportedParams(params);

      const artifacts = await Promise.all(indexPaths.map(indexPath => this.readArtifact(indexPath)));
      const chunks = artifacts.flatMap(artifact => {
        this.assertCompatibleArtifact(artifact, params);
        return artifact.chunks;
      });

      return this.rebuildIndex(chunks, params, outputPath);
    } catch (error) {
      errorHandler.handleError(
        new VectorStoreError(`Index merge failed: ${(error as Error).message}`, {
          code: ErrorCodes.VECTOR_STORE_INITIALIZATION_FAILED,
          details: {
            indexPaths,
            outputPath,
            error,
          },
          recoverable: false,
        })
      );

      return false;
    }
  }

  /**
   * Split a flat index artifact into multiple shard artifacts.
   *
   * @param indexPath - The path to the index to split
   * @param outputDir - The directory to save the shards
   * @param numShards - The number of shards to create
   * @param params - The index parameters for the shards
   * @returns Whether the split was successful
   */
  public async splitIndex(indexPath: string, outputDir: string, numShards: number, params: IndexParams): Promise<boolean> {
    try {
      this.assertSupportedParams(params);

      if (!Number.isInteger(numShards) || numShards < 1) {
        throw new Error('numShards must be a positive integer');
      }

      const artifact = await this.readArtifact(indexPath);
      this.assertCompatibleArtifact(artifact, params);

      await fs.promises.mkdir(outputDir, { recursive: true });

      const shardSize = Math.ceil(artifact.chunks.length / numShards);
      await Promise.all(
        Array.from({ length: numShards }, async (_, shardIndex) => {
          const start = shardIndex * shardSize;
          const end = start + shardSize;
          const shardChunks = artifact.chunks.slice(start, end);
          const shardPath = path.join(outputDir, `shard-${shardIndex}.flat-index.json`);
          await this.writeArtifact(shardPath, this.createFlatArtifact(shardChunks, params));
        })
      );

      return true;
    } catch (error) {
      errorHandler.handleError(
        new VectorStoreError(`Index split failed: ${(error as Error).message}`, {
          code: ErrorCodes.VECTOR_STORE_INITIALIZATION_FAILED,
          details: {
            indexPath,
            outputDir,
            numShards,
            error,
          },
          recoverable: false,
        })
      );

      return false;
    }
  }

  public async loadFlatIndex(indexPath: string): Promise<FlatIndexArtifact> {
    return this.readArtifact(indexPath);
  }

  private assertSupportedParams(params: IndexParams): void {
    if (params.type !== IndexType.FLAT) {
      throw new Error(`Index type "${params.type}" is not supported in this release; only flat exact indexing is implemented`);
    }

    if (!Number.isInteger(params.dimension) || params.dimension <= 0) {
      throw new Error('Index dimension must be a positive integer');
    }

    const metric = params.metric || 'cosine';
    if (!['cosine', 'euclidean', 'dot'].includes(metric)) {
      throw new Error(`Unsupported metric: ${metric}`);
    }
  }

  private assertChunkDimensions(chunks: Chunk[], dimension: number): void {
    for (const chunk of chunks) {
      if (chunk.embedding.length !== dimension) {
        throw new Error(`Chunk ${chunk.id} embedding dimension ${chunk.embedding.length} does not match index dimension ${dimension}`);
      }
    }
  }

  private assertCompatibleArtifact(artifact: FlatIndexArtifact, params: IndexParams): void {
    if (artifact.backend !== IndexType.FLAT || artifact.params.type !== IndexType.FLAT) {
      throw new Error('Only flat index artifacts are supported');
    }

    if (artifact.params.dimension !== params.dimension) {
      throw new Error(`Index dimension mismatch: expected ${params.dimension}, got ${artifact.params.dimension}`);
    }

    if (artifact.params.metric !== (params.metric || 'cosine')) {
      throw new Error(`Index metric mismatch: expected ${params.metric || 'cosine'}, got ${artifact.params.metric}`);
    }
  }

  private createFlatArtifact(chunks: Chunk[], params: IndexParams): FlatIndexArtifact {
    return {
      schemaVersion: 1,
      backend: IndexType.FLAT,
      params: {
        type: IndexType.FLAT,
        dimension: params.dimension,
        metric: params.metric || 'cosine',
      },
      size: chunks.length,
      entries: chunks.map((chunk, position) => ({
        id: chunk.id,
        position,
        embedding: [...chunk.embedding],
      })),
      chunks: chunks.map(chunk => ({
        ...chunk,
        embedding: [...chunk.embedding],
        metadata: { ...chunk.metadata },
        summaries: chunk.summaries.map(summary => ({
          ...summary,
          concepts: [...summary.concepts],
        })),
      })),
      createdAt: new Date().toISOString(),
    };
  }

  private async writeArtifact(outputPath: string, artifact: FlatIndexArtifact): Promise<void> {
    const outputDir = path.dirname(outputPath);
    await fs.promises.mkdir(outputDir, { recursive: true });

    const tempPath = `${outputPath}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(artifact, null, 2), 'utf-8');
    await fs.promises.rename(tempPath, outputPath);
  }

  private async readArtifact(indexPath: string): Promise<FlatIndexArtifact> {
    const indexData = await fs.promises.readFile(indexPath, 'utf-8');
    const artifact = JSON.parse(indexData) as FlatIndexArtifact;

    if (artifact.schemaVersion !== 1 || artifact.backend !== IndexType.FLAT || !Array.isArray(artifact.entries) || !Array.isArray(artifact.chunks)) {
      throw new Error(`Invalid or unsupported index artifact: ${indexPath}`);
    }

    if (artifact.entries.length !== artifact.chunks.length || artifact.size !== artifact.chunks.length) {
      throw new Error(`Corrupt flat index artifact: ${indexPath}`);
    }

    this.assertSupportedParams(artifact.params);
    this.assertChunkDimensions(artifact.chunks, artifact.params.dimension);

    return artifact;
  }
}

// Export the singleton instance
export const indexManager = IndexManager.getInstance();

/**
 * Utility function to get the optimal index parameters
 *
 * @param size - The number of vectors in the dataset
 * @param dimension - The dimension of the vectors
 * @param memoryBudget - Reserved for future approximate backends
 * @returns The optimal supported index parameters
 */
export function getOptimalIndexParams(size: number, dimension: number, memoryBudget?: number): IndexParams {
  return indexManager.getOptimalIndexParams(size, dimension, memoryBudget);
}

/**
 * Utility function to estimate the memory usage of an index
 *
 * @param params - The index parameters
 * @param size - The number of vectors in the index
 * @returns The estimated memory usage in bytes
 */
export function estimateMemoryUsage(params: IndexParams, size: number): number {
  return indexManager.estimateMemoryUsage(params, size);
}

/**
 * Utility function to check if an index needs optimization
 *
 * @param stats - The current index statistics
 * @param options - The optimization options
 * @returns Whether the index needs optimization
 */
export function needsOptimization(stats: IndexStats, options: OptimizationOptions = {}): boolean {
  return indexManager.needsOptimization(stats, options);
}

/**
 * Utility function to optimize an index
 *
 * @param chunks - The chunks in the index
 * @param currentParams - The current index parameters
 * @param options - The optimization options
 * @returns The optimized index parameters
 */
export function optimizeIndex(chunks: Chunk[], currentParams: IndexParams, options: OptimizationOptions = {}): IndexParams {
  return indexManager.optimizeIndex(chunks, currentParams, options);
}

/**
 * Utility function to rebuild an index
 *
 * @param chunks - The chunks to include in the index
 * @param params - The index parameters
 * @param outputPath - The path to save the index
 * @returns Whether the rebuild was successful
 */
export function rebuildIndex(chunks: Chunk[], params: IndexParams, outputPath: string): Promise<boolean> {
  return indexManager.rebuildIndex(chunks, params, outputPath);
}

/**
 * Utility function to merge multiple indices
 *
 * @param indexPaths - The paths to the indices to merge
 * @param outputPath - The path to save the merged index
 * @param params - The index parameters for the merged index
 * @returns Whether the merge was successful
 */
export function mergeIndices(indexPaths: string[], outputPath: string, params: IndexParams): Promise<boolean> {
  return indexManager.mergeIndices(indexPaths, outputPath, params);
}

/**
 * Utility function to split an index into multiple shards
 *
 * @param indexPath - The path to the index to split
 * @param outputDir - The directory to save the shards
 * @param numShards - The number of shards to create
 * @param params - The index parameters for the shards
 * @returns Whether the split was successful
 */
export function splitIndex(indexPath: string, outputDir: string, numShards: number, params: IndexParams): Promise<boolean> {
  return indexManager.splitIndex(indexPath, outputDir, numShards, params);
}
