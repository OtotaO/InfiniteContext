import { ExtractedMemory, MemoryExtractionInput, MemoryExtractor } from './types.js';

const DEFAULT_CONFIDENCE = 0.5;
const MAX_TRACE_LENGTH = 80;

/**
 * JSON schema describing the normalized memory extraction payload.
 *
 * Extractor implementations can use this schema when prompting LLMs or validating
 * outputs from local models/rule engines before they are written into memory.
 */
export const extractedMemoryJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'ExtractedMemory',
  type: 'object',
  additionalProperties: false,
  required: [
    'domain',
    'category',
    'memoryTrace',
    'episodeText',
    'timestamp',
    'userProfileAttributes',
    'confidence'
  ],
  properties: {
    domain: {
      type: 'string',
      minLength: 1,
      description: 'Top-level knowledge or application domain for the memory.'
    },
    category: {
      type: 'string',
      minLength: 1,
      description: 'Second-level grouping inside the domain.'
    },
    memoryTrace: {
      type: 'string',
      minLength: 1,
      description: 'Stable trace or thread label that related episodes should share.'
    },
    episodeText: {
      type: 'string',
      minLength: 1,
      description: 'Episode-level text to store under the resolved trace node.'
    },
    timestamp: {
      type: 'string',
      format: 'date-time',
      description: 'ISO-8601 timestamp for the episode.'
    },
    userProfileAttributes: {
      type: 'object',
      additionalProperties: true,
      description: 'Extracted durable user attributes or preferences relevant to the episode.'
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Extractor confidence from 0 to 1.'
    }
  }
} as const;

/**
 * Deterministic fallback extractor that requires no model provider.
 *
 * This implementation intentionally performs conservative extraction: it derives
 * hierarchy labels from explicit metadata first, then from prompt/output text, and
 * only captures simple user profile attributes that are stated with common phrases.
 */
export class DeterministicMemoryExtractor implements MemoryExtractor {
  public async extractMemory(input: MemoryExtractionInput): Promise<ExtractedMemory> {
    const timestamp = input.timestamp || new Date().toISOString();
    const combinedText = `${input.prompt}\n${input.output}`.trim();
    const metadata = input.metadata || {};

    const domain = this.normalizeLabel(
      this.readString(metadata.domain) || this.inferDomain(combinedText),
      'general'
    );
    const category = this.normalizeLabel(
      this.readString(metadata.category) || this.readString(metadata.bucketName) || this.inferCategory(input.prompt),
      'conversation'
    );
    const memoryTrace = this.buildTrace(
      this.readString(metadata.memoryTrace) || this.readString(metadata.trace) || input.prompt || input.output
    );

    return {
      domain,
      category,
      memoryTrace,
      episodeText: `Prompt: ${input.prompt}\n\nOutput: ${input.output}`,
      timestamp,
      userProfileAttributes: this.extractUserProfileAttributes(combinedText),
      confidence: this.estimateConfidence(metadata, combinedText)
    };
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  }

  private normalizeLabel(value: string | undefined, fallback: string): string {
    const normalized = (value || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return normalized || fallback;
  }

  private inferDomain(text: string): string {
    const lowerText = text.toLowerCase();

    if (/(code|typescript|javascript|python|api|function|class|repo|database|server)/.test(lowerText)) {
      return 'software';
    }

    if (/(account|invoice|budget|payment|revenue|expense|financial)/.test(lowerText)) {
      return 'finance';
    }

    if (/(trip|flight|hotel|restaurant|city|travel|itinerary)/.test(lowerText)) {
      return 'travel';
    }

    if (/(health|doctor|medicine|symptom|workout|nutrition)/.test(lowerText)) {
      return 'health';
    }

    return 'general';
  }

  private inferCategory(prompt: string): string {
    const firstSentence = prompt.split(/[.!?\n]/).find(part => part.trim().length > 0);
    const significantWords = (firstSentence || prompt)
      .toLowerCase()
      .match(/[a-z0-9]{4,}/g)
      ?.slice(0, 3);

    return significantWords && significantWords.length > 0
      ? significantWords.join('-')
      : 'conversation';
  }

  private buildTrace(seed: string): string {
    const words = seed
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g)
      ?.slice(0, 8) || ['memory', 'trace'];

    const trace = words.join('-').slice(0, MAX_TRACE_LENGTH).replace(/-+$/g, '');
    return trace || 'memory-trace';
  }

  private extractUserProfileAttributes(text: string): Record<string, unknown> {
    const attributes: Record<string, unknown> = {};
    const nameMatch = text.match(/\b(?:my name is|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
    const preferenceMatches = Array.from(text.matchAll(/\b(?:i prefer|i like|my preference is)\s+([^.!?\n]+)/gi));

    if (nameMatch) {
      attributes.name = nameMatch[1].trim();
    }

    if (preferenceMatches.length > 0) {
      attributes.preferences = preferenceMatches
        .map(match => match[1].trim())
        .filter(Boolean);
    }

    return attributes;
  }

  private estimateConfidence(metadata: Record<string, unknown>, text: string): number {
    let confidence = DEFAULT_CONFIDENCE;

    if (this.readString(metadata.domain)) confidence += 0.15;
    if (this.readString(metadata.category) || this.readString(metadata.bucketName)) confidence += 0.1;
    if (this.readString(metadata.memoryTrace) || this.readString(metadata.trace)) confidence += 0.1;
    if (Object.keys(this.extractUserProfileAttributes(text)).length > 0) confidence += 0.05;

    return Math.min(0.9, Number(confidence.toFixed(2)));
  }
}
