/**
 * PromptCategorizer: Main categorization system for InfiniteContext
 * 
 * This class is responsible for categorizing prompts and their outputs
 * to determine the most appropriate bucket for storage.
 */

import { Bucket } from '../core/Bucket.js';
import { Chunk, Vector } from '../core/types.js';
import { MemoryManager } from '../core/MemoryManager.js';
import { CategoryMetadata, CacheEntry, CategorizationResult, CategoryMatch } from './models/CategoryModel.js';
import { CategorizationStrategy } from './strategies/StrategyInterface.js';
import { KeywordStrategy } from './strategies/KeywordStrategy.js';
import { VectorSimilarityStrategy } from './strategies/VectorSimilarityStrategy.js';
import { AdaptiveStrategy } from './strategies/AdaptiveStrategy.js';
import { CategoryCache, CategoryCacheOptions } from './utils/CategoryCache.js';
import { extractKeywords, generatePatternsFromKeywords, hashString } from './utils/TextAnalyzer.js';

/**
 * Options for the PromptCategorizer
 */
export interface PromptCategorizerOptions {
  cacheOptions?: CategoryCacheOptions;
  embeddingFunction: (text: string) => Promise<Vector>;
  enableLearning?: boolean;
  defaultThresholds?: {
    keywordMatchThreshold: number;
    vectorSimilarityThreshold: number;
  };
}

/**
 * Main categorization system for InfiniteContext
 */
export class PromptCategorizer {
  private categories: CategoryMetadata[] = [];
  private cache: CategoryCache;
  private strategies: CategorizationStrategy[] = [];
  private adaptiveStrategy?: AdaptiveStrategy;
  private defaultThresholds: {
    keywordMatchThreshold: number;
    vectorSimilarityThreshold: number;
  };
  
  /**
   * Create a new PromptCategorizer
   * 
   * @param memoryManager - The memory manager to get buckets from
   * @param options - Configuration options
   */
  constructor(
    private memoryManager: MemoryManager,
    private options: PromptCategorizerOptions
  ) {
    // Initialize cache
    this.cache = new CategoryCache(options.cacheOptions);
    
    // Set default thresholds
    this.defaultThresholds = options.defaultThresholds || {
      keywordMatchThreshold: 0.3,
      vectorSimilarityThreshold: 0.7
    };
    
    // Initialize strategies in order of execution (fastest first)
    this.strategies = [
      new KeywordStrategy(),
      new VectorSimilarityStrategy(options.embeddingFunction)
    ];
    
    if (options.enableLearning !== false) {
      this.adaptiveStrategy = new AdaptiveStrategy();
      this.strategies.push(this.adaptiveStrategy);
    }
    
    // Load initial categories from existing buckets
    this.initializeFromBuckets();
  }
  
  /**
   * Initialize categories from existing buckets
   */
  private async initializeFromBuckets(): Promise<void> {
    const buckets = this.memoryManager.getBuckets();
    
    for (const bucket of buckets.values()) {
      await this.addCategoryFromBucket(bucket);
    }
    
    console.log(`Initialized ${this.categories.length} categories from existing buckets`);
  }
  
  /**
   * Add a category from a bucket
   * 
   * @param bucket - The bucket to create a category from
   */
  private async addCategoryFromBucket(bucket: Bucket): Promise<void> {
    const id = bucket.getId();
    const name = bucket.getName();
    const domain = bucket.getDomain();
    
    // Extract keywords from bucket content
    const chunks = bucket.getAllChunks();
    const keywords = await this.extractKeywordsFromChunks(chunks);
    
    // Generate representative embeddings
    const representativeEmbeddings = await this.generateRepresentativeEmbeddings(chunks);
    
    // Create category metadata
    const category: CategoryMetadata = {
      id,
      name,
      domain,
      description: bucket.getDescription(),
      keywords,
      patterns: generatePatternsFromKeywords(keywords),
      representativeEmbeddings,
      examplePrompts: this.extractExamplePrompts(chunks),
      lastUpdated: new Date().toISOString(),
      confidence: {
        keywordMatchThreshold: this.defaultThresholds.keywordMatchThreshold,
        vectorSimilarityThreshold: this.defaultThresholds.vectorSimilarityThreshold
      }
    };
    
    this.categories.push(category);
  }
  
  /**
   * Categorize a prompt and its output
   * 
   * @param prompt - The prompt text
   * @param output - The output text
   * @returns The categorization result
   */
  public async categorize(
    prompt: string, 
    output: string
  ): Promise<CategorizationResult> {
    // Check cache first
    const promptHash = hashString(prompt);
    const cachedResult = this.cache.get(promptHash);
    
    if (cachedResult) {
      // Update usage count
      cachedResult.usageCount++;
      
      const category = this.categories.find(c => c.id === cachedResult.categoryId);
      if (category) {
        return {
          bucketName: category.name,
          bucketDomain: category.domain,
          confidence: cachedResult.confidence,
          strategy: 'cache'
        };
      }
    }
    
    // Try each strategy in sequence
    let bestMatch: CategoryMatch | null = null;
    let strategyUsed = '';
    
    for (const strategy of this.strategies) {
      const matches = await strategy.categorize(prompt, output, this.categories);
      
      if (matches.length > 0 && (!bestMatch || matches[0].score > bestMatch.score)) {
        bestMatch = matches[0];
        strategyUsed = matches[0].strategy;
        
        // If we have a high-confidence match, stop trying strategies
        if (bestMatch.score > 0.8) {
          break;
        }
      }
    }
    
    if (!bestMatch) {
      // If no match found, use default bucket
      return {
        bucketName: 'default',
        bucketDomain: 'general',
        confidence: 0,
        strategy: 'default'
      };
    }
    
    const category = this.categories.find(c => c.id === bestMatch!.categoryId);
    
    if (!category) {
      // This shouldn't happen, but just in case
      return {
        bucketName: 'default',
        bucketDomain: 'general',
        confidence: 0,
        strategy: 'default'
      };
    }
    
    // Cache the result for future use
    this.cache.set(promptHash, {
      promptHash,
      categoryId: category.id,
      confidence: bestMatch.score,
      timestamp: new Date().toISOString(),
      usageCount: 1
    });
    
    return {
      bucketName: category.name,
      bucketDomain: category.domain,
      confidence: bestMatch.score,
      strategy: strategyUsed
    };
  }
  
  /**
   * Record feedback about a categorization
   * 
   * @param prompt - The prompt text
   * @param output - The output text
   * @param assignedCategory - The category that was assigned
   * @param correctedCategory - The category that should have been assigned (if different)
   */
  public recordFeedback(
    prompt: string,
    output: string,
    assignedCategory: string,
    correctedCategory?: string
  ): void {
    if (this.adaptiveStrategy) {
      this.adaptiveStrategy.recordFeedback(
        prompt,
        output,
        assignedCategory,
        correctedCategory
      );
      
      // If there was a correction, update the cache
      if (correctedCategory) {
        const promptHash = hashString(prompt);
        this.cache.delete(promptHash);
      }
    }
  }
  
  /**
   * Update categories from current buckets
   * 
   * This should be called periodically to keep categories up to date
   */
  public async updateCategories(): Promise<void> {
    const buckets = this.memoryManager.getBuckets();
    
    for (const bucket of buckets.values()) {
      const id = bucket.getId();
      const existingCategory = this.categories.find(c => c.id === id);
      
      if (existingCategory) {
        // Update existing category
        const chunks = bucket.getAllChunks();
        
        // Only update if there are chunks
        if (chunks.length > 0) {
          existingCategory.keywords = await this.extractKeywordsFromChunks(chunks);
          existingCategory.patterns = generatePatternsFromKeywords(existingCategory.keywords);
          existingCategory.representativeEmbeddings = await this.generateRepresentativeEmbeddings(chunks);
          existingCategory.lastUpdated = new Date().toISOString();
        }
      } else {
        // Add new category
        await this.addCategoryFromBucket(bucket);
      }
    }
    
    // Remove categories for buckets that no longer exist
    const bucketIds = Array.from(buckets.keys());
    this.categories = this.categories.filter(category => 
      bucketIds.includes(category.id)
    );
    
    console.log(`Updated categories: ${this.categories.length} total`);
  }
  
  /**
   * Extract keywords from chunks
   * 
   * @param chunks - The chunks to extract keywords from
   * @returns Array of keywords
   */
  private async extractKeywordsFromChunks(chunks: Chunk[]): Promise<string[]> {
    if (chunks.length === 0) {
      return [];
    }
    
    // Combine all chunk content
    const allText = chunks.map(chunk => chunk.content).join(' ');
    
    // Extract keywords
    return extractKeywords(allText, 20);
  }
  
  /**
   * Generate representative embeddings for a set of chunks
   * 
   * @param chunks - The chunks to generate embeddings for
   * @returns Array of representative embeddings
   */
  private async generateRepresentativeEmbeddings(chunks: Chunk[]): Promise<Vector[]> {
    if (chunks.length === 0) {
      return [];
    }
    
    // Use existing embeddings if available
    const embeddings = chunks.map(chunk => chunk.embedding);
    
    // Calculate centroid (average) embedding
    const dimension = embeddings[0].length;
    const centroid = new Array(dimension).fill(0);
    
    for (const embedding of embeddings) {
      for (let i = 0; i < dimension; i++) {
        centroid[i] += embedding[i] / embeddings.length;
      }
    }
    
    // Normalize the centroid
    const magnitude = Math.sqrt(centroid.reduce((sum, val) => sum + val * val, 0));
    if (magnitude > 0) {
      for (let i = 0; i < dimension; i++) {
        centroid[i] /= magnitude;
      }
    }
    
    return [centroid];
  }
  
  /**
   * Extract example prompts from chunks
   * 
   * @param chunks - The chunks to extract prompts from
   * @returns Array of example prompts
   */
  private extractExamplePrompts(chunks: Chunk[]): string[] {
    // Extract prompts from metadata
    return chunks
      .filter(chunk => chunk.metadata.prompt)
      .slice(0, 5)
      .map(chunk => chunk.metadata.prompt as string);
  }
  
  /**
   * Get all categories
   * 
   * @returns Array of categories
   */
  public getCategories(): CategoryMetadata[] {
    return [...this.categories];
  }
  
  /**
   * Get cache statistics
   * 
   * @returns Cache statistics
   */
  public getCacheStats(): { size: number } {
    return {
      size: this.cache.size()
    };
  }
  
  /**
   * Clear the cache
   */
  public clearCache(): void {
    this.cache.clear();
  }
}
