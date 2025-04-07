/**
 * Data models for the categorization system
 */

import { Vector } from '../../core/types.js';

/**
 * Metadata for a category (corresponds to a bucket)
 */
export interface CategoryMetadata {
  id: string;
  name: string;
  domain: string;
  description?: string;
  keywords: string[];
  patterns: RegExp[];
  representativeEmbeddings: Vector[];  // Centroid vectors representing this category
  examplePrompts: string[];            // Example prompts that belong to this category
  lastUpdated: string;                 // ISO timestamp
  confidence: {
    keywordMatchThreshold: number;     // Minimum keyword match score (0-1)
    vectorSimilarityThreshold: number; // Minimum similarity score (0-1)
  };
}

/**
 * Entry in the categorization cache
 */
export interface CacheEntry {
  promptHash: string;                  // Hash of the prompt for quick lookup
  categoryId: string;                  // ID of the matched category
  confidence: number;                  // Confidence score (0-1)
  timestamp: string;                   // When this entry was added/updated
  usageCount: number;                  // How many times this entry has been used
}

/**
 * Result of a categorization strategy
 */
export interface CategoryMatch {
  categoryId: string;
  score: number;
  strategy: string;
}

/**
 * Result of the categorization process
 */
export interface CategorizationResult {
  bucketName: string;
  bucketDomain: string;
  confidence: number;
  strategy: string;
}
