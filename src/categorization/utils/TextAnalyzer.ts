/**
 * Text analysis utilities for categorization
 * 
 * This utility provides functions for analyzing text content,
 * extracting keywords, and generating features for categorization.
 */

/**
 * Common English stop words to filter out
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to', 'from',
  'by', 'with', 'in', 'out', 'over', 'under', 'again', 'further', 'then', 'once',
  'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don',
  'should', 'now', 'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves',
  'you', 'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their',
  'theirs', 'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these',
  'those', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'having', 'do', 'does', 'did', 'doing', 'would', 'could', 'should',
  'ought', 'i\'m', 'you\'re', 'he\'s', 'she\'s', 'it\'s', 'we\'re', 'they\'re',
  'i\'ve', 'you\'ve', 'we\'ve', 'they\'ve', 'i\'d', 'you\'d', 'he\'d', 'she\'d',
  'we\'d', 'they\'d', 'i\'ll', 'you\'ll', 'he\'ll', 'she\'ll', 'we\'ll', 'they\'ll',
  'isn\'t', 'aren\'t', 'wasn\'t', 'weren\'t', 'hasn\'t', 'haven\'t', 'hadn\'t',
  'doesn\'t', 'don\'t', 'didn\'t', 'won\'t', 'wouldn\'t', 'shan\'t', 'shouldn\'t',
  'can\'t', 'cannot', 'couldn\'t', 'mustn\'t', 'let\'s', 'that\'s', 'who\'s',
  'what\'s', 'here\'s', 'there\'s', 'when\'s', 'where\'s', 'why\'s', 'how\'s'
]);

/**
 * Extract keywords from text
 * 
 * @param text - The text to extract keywords from
 * @param maxKeywords - Maximum number of keywords to extract
 * @returns Array of keywords
 */
export function extractKeywords(text: string, maxKeywords: number = 20): string[] {
  // Normalize text
  const normalizedText = text.toLowerCase();
  
  // Split into words and filter out stop words and short words
  const words = normalizedText
    .split(/\W+/)
    .filter(word => word.length > 3 && !STOP_WORDS.has(word));
  
  // Count word frequencies
  const wordFrequency = new Map<string, number>();
  
  for (const word of words) {
    wordFrequency.set(word, (wordFrequency.get(word) || 0) + 1);
  }
  
  // Sort by frequency and take top N
  return Array.from(wordFrequency.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([word]) => word);
}

/**
 * Generate regex patterns from keywords
 * 
 * @param keywords - Array of keywords
 * @returns Array of regex patterns
 */
export function generatePatternsFromKeywords(keywords: string[]): RegExp[] {
  return keywords.map(keyword => 
    new RegExp(`\\b${keyword}\\b`, 'i')
  );
}

/**
 * Detect the primary content type of text
 * 
 * @param text - The text to analyze
 * @returns The detected content type
 */
export function detectContentType(text: string): 'code' | 'question' | 'command' | 'general' {
  // Check for code
  if (
    text.includes('```') || 
    /\b(function|class|import|export|const|var|let|return)\b/.test(text) ||
    /\b(def|class|import|from|return|if|else|for|while)\b/.test(text)
  ) {
    return 'code';
  }
  
  // Check for questions
  if (text.includes('?') && /\b(what|how|why|when|where|who|which)\b/i.test(text)) {
    return 'question';
  }
  
  // Check for commands
  if (
    /\b(run|execute|install|create|delete|remove|add|update|set|get)\b/i.test(text) ||
    text.includes('$') || 
    text.includes('>')
  ) {
    return 'command';
  }
  
  // Default to general
  return 'general';
}

/**
 * Calculate text similarity using Jaccard index
 * 
 * @param text1 - First text
 * @param text2 - Second text
 * @returns Similarity score (0-1)
 */
export function calculateTextSimilarity(text1: string, text2: string): number {
  // Extract words from both texts
  const words1 = new Set(
    text1.toLowerCase().split(/\W+/).filter(word => word.length > 3)
  );
  const words2 = new Set(
    text2.toLowerCase().split(/\W+/).filter(word => word.length > 3)
  );
  
  // Calculate intersection and union
  const intersection = new Set([...words1].filter(word => words2.has(word)));
  const union = new Set([...words1, ...words2]);
  
  // Calculate Jaccard index
  return intersection.size / union.size;
}

/**
 * Extract entities (names, places, organizations) from text
 * 
 * @param text - The text to analyze
 * @returns Array of extracted entities
 */
export function extractEntities(text: string): string[] {
  // This is a simplified implementation
  // In a real implementation, this would use a more sophisticated NER model
  
  // Look for capitalized words that aren't at the start of sentences
  const entities = new Set<string>();
  const words = text.split(/\s+/);
  
  for (let i = 1; i < words.length; i++) {
    const word = words[i].replace(/[^\w\s]/g, '');
    
    if (word.length > 1 && /^[A-Z][a-z]+$/.test(word) && !STOP_WORDS.has(word.toLowerCase())) {
      entities.add(word);
    }
  }
  
  return Array.from(entities);
}

/**
 * Generate a hash for a string
 * 
 * @param str - The string to hash
 * @returns A hash string
 */
export function hashString(str: string): string {
  let hash = 0;
  
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  return hash.toString(16);
}
