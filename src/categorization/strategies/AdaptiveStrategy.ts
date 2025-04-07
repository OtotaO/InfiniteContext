/**
 * Adaptive categorization strategy
 * 
 * This strategy learns from past categorizations and user feedback
 * to improve categorization accuracy over time.
 */

import { CategorizationStrategy } from './StrategyInterface.js';
import { CategoryMatch, CategoryMetadata } from '../models/CategoryModel.js';

/**
 * Feedback record for training the adaptive strategy
 */
interface FeedbackRecord {
  prompt: string;
  output: string;
  assignedCategory: string;
  correctedCategory?: string;
  timestamp: string;
  features: number[];
}

/**
 * Usage statistics for a category
 */
interface CategoryUsageStats {
  totalUses: number;
  successfulUses: number;
  averageConfidence: number;
}

/**
 * Strategy that learns from past categorizations and user feedback
 */
export class AdaptiveStrategy implements CategorizationStrategy {
  private categoryUsageStats: Map<string, CategoryUsageStats> = new Map();
  private userFeedback: FeedbackRecord[] = [];
  private featureExtractors: Array<(prompt: string, output: string) => number> = [];
  
  /**
   * Create a new AdaptiveStrategy
   */
  constructor() {
    // Initialize feature extractors
    this.initializeFeatureExtractors();
  }
  
  /**
   * Categorize a prompt and its output using learned patterns
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
    // Extract features from prompt and output
    const features = this.extractFeatures(prompt, output);
    
    // Use a simple ML model to predict category
    const predictions = this.predictCategories(features, categories);
    
    // Adjust scores based on usage statistics
    const adjustedPredictions = predictions.map(prediction => {
      const stats = this.categoryUsageStats.get(prediction.categoryId);
      
      if (stats && stats.totalUses > 0) {
        const successRate = stats.successfulUses / stats.totalUses;
        // Adjust score based on success rate
        prediction.score = prediction.score * (0.5 + 0.5 * successRate);
      }
      
      return prediction;
    });
    
    // Sort by score (descending)
    return adjustedPredictions.sort((a, b) => b.score - a.score);
  }
  
  /**
   * Record user feedback for future learning
   * 
   * @param prompt - The prompt text
   * @param output - The output text
   * @param assignedCategory - The category that was assigned
   * @param correctedCategory - The category that should have been assigned (if different)
   */
  recordFeedback(
    prompt: string, 
    output: string, 
    assignedCategory: string, 
    correctedCategory?: string
  ): void {
    // Extract features for this feedback
    const features = this.extractFeatures(prompt, output);
    
    // Add to feedback records
    this.userFeedback.push({
      prompt,
      output,
      assignedCategory,
      correctedCategory,
      timestamp: new Date().toISOString(),
      features
    });
    
    // Update usage statistics for assigned category
    this.updateCategoryStats(assignedCategory, !correctedCategory);
    
    // If a correction was made, also update the corrected category
    if (correctedCategory) {
      this.updateCategoryStats(correctedCategory, true);
    }
    
    // Periodically retrain the model
    this.checkAndRetrain();
  }
  
  /**
   * Initialize feature extractors
   */
  private initializeFeatureExtractors(): void {
    // Text length features
    this.featureExtractors.push(
      (prompt, output) => prompt.length / 1000, // Normalized prompt length
      (prompt, output) => output.length / 1000, // Normalized output length
      (prompt, output) => prompt.split(/\s+/).length / 100, // Normalized word count
      (prompt, output) => output.split(/\s+/).length / 100 // Normalized word count
    );
    
    // Question features
    this.featureExtractors.push(
      (prompt, output) => prompt.includes('?') ? 1 : 0, // Is prompt a question?
      (prompt, output) => (prompt.match(/\?/g) || []).length / 10 // Number of questions
    );
    
    // Code features
    this.featureExtractors.push(
      (prompt, output) => prompt.includes('```') ? 1 : 0, // Contains code blocks
      (prompt, output) => output.includes('```') ? 1 : 0, // Contains code blocks
      (prompt, output) => {
        // Check for common programming keywords
        const codeKeywords = ['function', 'class', 'import', 'const', 'var', 'let', 'return'];
        return codeKeywords.filter(kw => prompt.includes(kw)).length / codeKeywords.length;
      }
    );
    
    // Command features
    this.featureExtractors.push(
      (prompt, output) => prompt.includes('$') || prompt.includes('>') ? 1 : 0, // Contains command prompts
      (prompt, output) => output.includes('$') || output.includes('>') ? 1 : 0 // Contains command prompts
    );
  }
  
  /**
   * Extract features from prompt and output
   * 
   * @param prompt - The prompt text
   * @param output - The output text
   * @returns Array of numerical features
   */
  private extractFeatures(prompt: string, output: string): number[] {
    return this.featureExtractors.map(extractor => extractor(prompt, output));
  }
  
  /**
   * Predict categories based on features
   * 
   * @param features - Extracted features
   * @param categories - Available categories
   * @returns Array of category matches with scores
   */
  private predictCategories(features: number[], categories: CategoryMetadata[]): CategoryMatch[] {
    // If we don't have enough feedback data, return empty predictions
    if (this.userFeedback.length < 10) {
      return [];
    }
    
    const predictions: CategoryMatch[] = [];
    
    // For each category, calculate similarity to previous feedback
    for (const category of categories) {
      // Find feedback records for this category
      const categoryFeedback = this.userFeedback.filter(fb => 
        fb.correctedCategory === category.id || 
        (fb.assignedCategory === category.id && !fb.correctedCategory)
      );
      
      // Skip categories with no feedback
      if (categoryFeedback.length === 0) {
        continue;
      }
      
      // Calculate similarity to each feedback record
      const similarities = categoryFeedback.map(fb => {
        return this.featureSimilarity(features, fb.features);
      });
      
      // Use the highest similarity as the score
      const score = Math.max(...similarities);
      
      predictions.push({
        categoryId: category.id,
        score,
        strategy: 'adaptive'
      });
    }
    
    return predictions;
  }
  
  /**
   * Calculate similarity between feature vectors
   * 
   * @param a - First feature vector
   * @param b - Second feature vector
   * @returns Similarity score (0-1)
   */
  private featureSimilarity(a: number[], b: number[]): number {
    // Use Euclidean distance, converted to similarity
    let sumSquaredDiff = 0;
    
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sumSquaredDiff += diff * diff;
    }
    
    const distance = Math.sqrt(sumSquaredDiff);
    
    // Convert distance to similarity (1 for identical, approaching 0 for very different)
    return 1 / (1 + distance);
  }
  
  /**
   * Update usage statistics for a category
   * 
   * @param categoryId - The category ID
   * @param successful - Whether the categorization was successful
   */
  private updateCategoryStats(categoryId: string, successful: boolean): void {
    const stats = this.categoryUsageStats.get(categoryId) || {
      totalUses: 0,
      successfulUses: 0,
      averageConfidence: 0
    };
    
    stats.totalUses++;
    
    if (successful) {
      stats.successfulUses++;
    }
    
    this.categoryUsageStats.set(categoryId, stats);
  }
  
  /**
   * Check if we have enough new data to warrant retraining
   */
  private checkAndRetrain(): void {
    // Retrain every 100 feedback records
    if (this.userFeedback.length % 100 === 0 && this.userFeedback.length > 0) {
      this.retrainModel();
    }
  }
  
  /**
   * Retrain the model using accumulated feedback
   */
  private retrainModel(): void {
    // In a real implementation, this would train a more sophisticated model
    // For now, we just use the feedback directly in the prediction logic
    console.log(`Retraining adaptive model with ${this.userFeedback.length} feedback records`);
    
    // Optionally, we could prune old feedback to keep the model current
    if (this.userFeedback.length > 1000) {
      // Keep only the most recent 1000 records
      this.userFeedback = this.userFeedback.slice(-1000);
    }
  }
}
