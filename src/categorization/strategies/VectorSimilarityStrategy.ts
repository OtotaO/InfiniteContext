/**
 * Vector similarity-based categorization strategy
 * 
 * This strategy uses embeddings to find semantically similar categories
 * based on cosine similarity between the prompt/output and category
 * representative embeddings.
 */

import { CategorizationStrategy } from './StrategyInterface.js';
import { CategoryMatch, CategoryMetadata } from '../models/CategoryModel.js';
import { Vector } from '../../core/types.js';

/**
 * Strategy that uses vector embeddings for semantic categorization
 */
export class VectorSimilarityStrategy implements CategorizationStrategy {
  /**
   * Create a new VectorSimilarityStrategy
   * 
   * @param embeddingFunction - Function to generate embeddings from text
   */
  constructor(
    private embeddingFunction: (text: string) => Promise<Vector>
  ) {}
  
  /**
   * Categorize a prompt and its output using vector similarity
   * 
   * @param prompt - The prompt text
   * @param output - The output text
   * @param categories - Available categories to choose from
   * @returns Array of category matches, sorted by score (descending)
   */
  async categorize(
    prompt: string,
    output: string,
    categories: CategoryMetadata[]
  ): Promise<CategoryMatch[]> {
    // Generate embeddings for the prompt and output
    const promptEmbedding = await this.embeddingFunction(prompt);
    const outputEmbedding = await this.embeddingFunction(output);
    
    // Combine embeddings (weighted average)
    const combinedEmbedding = this.combineEmbeddings(
      promptEmbedding, 
      outputEmbedding,
      0.7  // Weight prompt higher than output
    );
    
    const matches: CategoryMatch[] = [];
    
    // Compare with each category's representative embeddings
    for (const category of categories) {
      // Skip categories with no representative embeddings
      if (!category.representativeEmbeddings || category.representativeEmbeddings.length === 0) {
        continue;
      }
      
      const similarities = category.representativeEmbeddings.map(embedding => 
        this.cosineSimilarity(combinedEmbedding, embedding)
      );
      
      // Use the highest similarity score
      const score = Math.max(...similarities);
      
      if (score >= category.confidence.vectorSimilarityThreshold) {
        matches.push({
          categoryId: category.id,
          score,
          strategy: 'vector'
        });
      }
    }
    
    // Sort by score (descending)
    return matches.sort((a, b) => b.score - a.score);
  }
  
  /**
   * Combine prompt and output embeddings with weighting
   * 
   * @param promptEmbedding - The prompt embedding
   * @param outputEmbedding - The output embedding
   * @param promptWeight - Weight to give the prompt (0-1)
   * @returns Combined embedding
   */
  private combineEmbeddings(
    promptEmbedding: Vector, 
    outputEmbedding: Vector, 
    promptWeight: number
  ): Vector {
    const outputWeight = 1 - promptWeight;
    return promptEmbedding.map((value, i) => 
      value * promptWeight + outputEmbedding[i] * outputWeight
    );
  }
  
  /**
   * Calculate cosine similarity between two vectors
   * 
   * @param a - First vector
   * @param b - Second vector
   * @returns Similarity score (0-1)
   */
  private cosineSimilarity(a: Vector, b: Vector): number {
    const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    
    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0;
    }
    
    return dotProduct / (magnitudeA * magnitudeB);
  }
}
