/**
 * Cache for categorization results
 * 
 * This utility provides efficient storage and retrieval of categorization
 * results to avoid redundant processing of similar prompts.
 */

import { CacheEntry } from '../models/CategoryModel.js';

/**
 * Options for the category cache
 */
export interface CategoryCacheOptions {
  maxSize?: number;           // Maximum number of entries to store
  expirationMs?: number;      // Time in milliseconds before entries expire
  pruneThreshold?: number;    // Percentage of maxSize at which to trigger pruning
}

/**
 * Cache for storing categorization results
 */
export class CategoryCache {
  private cache: Map<string, CacheEntry> = new Map();
  private options: CategoryCacheOptions;
  
  /**
   * Create a new CategoryCache
   * 
   * @param options - Cache configuration options
   */
  constructor(options: CategoryCacheOptions = {}) {
    this.options = {
      maxSize: options.maxSize || 1000,
      expirationMs: options.expirationMs || 24 * 60 * 60 * 1000, // 24 hours
      pruneThreshold: options.pruneThreshold || 0.9 // Prune at 90% capacity
    };
  }
  
  /**
   * Get a cache entry by prompt hash
   * 
   * @param promptHash - Hash of the prompt
   * @returns The cache entry, or undefined if not found or expired
   */
  get(promptHash: string): CacheEntry | undefined {
    const entry = this.cache.get(promptHash);
    
    if (!entry) {
      return undefined;
    }
    
    // Check if the entry has expired
    if (this.isExpired(entry)) {
      this.cache.delete(promptHash);
      return undefined;
    }
    
    return entry;
  }
  
  /**
   * Set a cache entry
   * 
   * @param promptHash - Hash of the prompt
   * @param entry - The cache entry to store
   */
  set(promptHash: string, entry: CacheEntry): void {
    this.cache.set(promptHash, entry);
    
    // Check if we need to prune the cache
    if (this.cache.size >= this.options.maxSize! * this.options.pruneThreshold!) {
      this.prune();
    }
  }
  
  /**
   * Delete a cache entry
   * 
   * @param promptHash - Hash of the prompt
   * @returns True if the entry was deleted, false if not found
   */
  delete(promptHash: string): boolean {
    return this.cache.delete(promptHash);
  }
  
  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }
  
  /**
   * Get the number of entries in the cache
   * 
   * @returns The number of entries
   */
  size(): number {
    return this.cache.size;
  }
  
  /**
   * Check if a cache entry has expired
   * 
   * @param entry - The cache entry to check
   * @returns True if the entry has expired
   */
  private isExpired(entry: CacheEntry): boolean {
    if (!this.options.expirationMs) {
      return false;
    }
    
    const now = Date.now();
    const timestamp = new Date(entry.timestamp).getTime();
    
    return now - timestamp > this.options.expirationMs;
  }
  
  /**
   * Prune the cache by removing the least valuable entries
   */
  private prune(): void {
    // If the cache is empty or below the threshold, do nothing
    if (this.cache.size <= this.options.maxSize! * 0.5) {
      return;
    }
    
    // Sort entries by value (usage count and recency)
    const entries = Array.from(this.cache.entries())
      .map(([key, entry]) => ({
        key,
        entry,
        value: this.calculateEntryValue(entry)
      }))
      .sort((a, b) => a.value - b.value); // Sort by value (ascending)
    
    // Calculate how many entries to remove
    const targetSize = Math.floor(this.options.maxSize! * 0.7); // Reduce to 70% capacity
    const removeCount = Math.max(0, this.cache.size - targetSize);
    
    // Remove the least valuable entries
    for (let i = 0; i < removeCount; i++) {
      this.cache.delete(entries[i].key);
    }
    
    console.log(`Pruned category cache from ${this.cache.size + removeCount} to ${this.cache.size} entries`);
  }
  
  /**
   * Calculate the value of a cache entry for pruning decisions
   * 
   * @param entry - The cache entry
   * @returns A value score (higher means more valuable)
   */
  private calculateEntryValue(entry: CacheEntry): number {
    const ageMs = Date.now() - new Date(entry.timestamp).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    
    // Value is based on usage count and recency
    // Higher usage count and more recent entries are more valuable
    return (ageHours + 1) / (entry.usageCount + 1);
  }
}
