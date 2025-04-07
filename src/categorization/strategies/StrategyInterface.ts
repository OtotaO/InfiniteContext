/**
 * Interface for categorization strategies
 */

import { CategoryMatch } from '../models/CategoryModel.js';
import { CategoryMetadata } from '../models/CategoryModel.js';

/**
 * Interface that all categorization strategies must implement
 */
export interface CategorizationStrategy {
  /**
   * Categorize a prompt and its output
   * 
   * @param prompt - The prompt text
   * @param output - The output text
   * @param categories - Available categories to choose from
   * @returns Array of category matches, sorted by score (descending)
   */
  categorize(
    prompt: string, 
    output: string, 
    categories: CategoryMetadata[]
  ): Promise<CategoryMatch[]>;
}
