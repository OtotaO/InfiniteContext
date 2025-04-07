/**
 * Keyword-based categorization strategy
 * 
 * This strategy uses keywords and regex patterns to quickly categorize
 * prompts and outputs without requiring embeddings.
 */

import { CategorizationStrategy } from './StrategyInterface.js';
import { CategoryMatch, CategoryMetadata } from '../models/CategoryModel.js';

/**
 * Strategy that uses keywords and patterns for fast categorization
 */
export class KeywordStrategy implements CategorizationStrategy {
  /**
   * Categorize a prompt and its output using keywords and patterns
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
    const normalizedPrompt = this.normalizeText(prompt);
    const normalizedOutput = this.normalizeText(output);
    const combinedText = `${normalizedPrompt} ${normalizedOutput}`;
    
    const matches: CategoryMatch[] = [];
    
    // Check each category's patterns and keywords
    for (const category of categories) {
      let score = 0;
      
      // Pattern matching (regex)
      for (const pattern of category.patterns) {
        if (pattern.test(combinedText)) {
          score += 0.5;  // Strong indicator
        }
      }
      
      // Keyword matching
      const keywordMatches = category.keywords.filter(keyword => 
        combinedText.includes(keyword)
      );
      
      // Calculate keyword match score (0-0.5)
      const keywordScore = category.keywords.length > 0
        ? (keywordMatches.length / category.keywords.length) * 0.5
        : 0;
      
      score += keywordScore;
      
      // Only include categories that meet the threshold
      if (score >= category.confidence.keywordMatchThreshold) {
        matches.push({
          categoryId: category.id,
          score,
          strategy: 'keyword'
        });
      }
    }
    
    // Sort by score (descending)
    return matches.sort((a, b) => b.score - a.score);
  }
  
  /**
   * Normalize text for consistent matching
   * 
   * @param text - The text to normalize
   * @returns Normalized text
   */
  private normalizeText(text: string): string {
    return text.toLowerCase().trim();
  }
}
