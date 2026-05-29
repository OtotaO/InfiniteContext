import { v4 as uuidv4 } from 'uuid';
import {
  UserProfileMemory,
  UserProfileMemoryField,
  UserProfileMemoryFieldCategory,
  UserProfilePrivacySettings,
} from './types.js';

export interface ProfileExtractionInput {
  content: string;
  userId?: string;
  episodeId?: string;
  traceId?: string;
  timestamp?: string;
}

export interface MemoryExtractorOptions {
  profilePrivacy?: Partial<UserProfilePrivacySettings>;
}

/**
 * Extracts durable memory signals from raw episodes.
 *
 * This implementation intentionally uses conservative, transparent heuristics so
 * applications can enable profile memory without requiring an LLM. Callers can
 * replace or wrap this class with richer extraction logic later.
 */
export class MemoryExtractor {
  private privacy: UserProfilePrivacySettings;

  constructor(options: MemoryExtractorOptions = {}) {
    this.privacy = {
      enabled: options.profilePrivacy?.enabled !== false,
      disabledFields: options.profilePrivacy?.disabledFields || [],
      disabledFieldKeys: options.profilePrivacy?.disabledFieldKeys || [],
    };
  }

  public setProfilePrivacy(settings: Partial<UserProfilePrivacySettings>): UserProfilePrivacySettings {
    this.privacy = {
      ...this.privacy,
      ...settings,
      disabledFields: settings.disabledFields || this.privacy.disabledFields,
      disabledFieldKeys: settings.disabledFieldKeys || this.privacy.disabledFieldKeys,
    };
    return this.getProfilePrivacy();
  }

  public getProfilePrivacy(): UserProfilePrivacySettings {
    return {
      enabled: this.privacy.enabled,
      disabledFields: [...this.privacy.disabledFields],
      disabledFieldKeys: [...this.privacy.disabledFieldKeys],
    };
  }

  public extractProfileMemory(input: ProfileExtractionInput): UserProfileMemory | null {
    if (!this.privacy.enabled) {
      return null;
    }

    const timestamp = input.timestamp || new Date().toISOString();
    const sourceEpisodeIds = input.episodeId ? [input.episodeId] : [];
    const traceIds = input.traceId ? [input.traceId] : [];
    const fields = this.extractFields(input.content, sourceEpisodeIds, traceIds, timestamp)
      .filter(field => this.isFieldAllowed(field));

    if (fields.length === 0) {
      return null;
    }

    const profile: UserProfileMemory = {
      id: uuidv4(),
      userId: input.userId,
      preferences: fields.filter(field => field.category === 'preferences'),
      interests: fields.filter(field => field.category === 'interests'),
      emotionalState: fields.filter(field => field.category === 'emotionalState'),
      behavioralPatterns: fields.filter(field => field.category === 'behavioralPatterns'),
      sourceEpisodeIds,
      traceIds,
      confidence: fields.reduce((sum, field) => sum + field.confidence, 0) / fields.length,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastObservedAt: timestamp,
    };

    return profile;
  }

  private extractFields(
    content: string,
    sourceEpisodeIds: string[],
    traceIds: string[],
    timestamp: string
  ): UserProfileMemoryField[] {
    const fields: UserProfileMemoryField[] = [];
    const patterns: Array<{ category: UserProfileMemoryFieldCategory; regex: RegExp; key: string; confidence: number }> = [
      { category: 'preferences', regex: /\bI\s+(?:prefer|like|love|want|need)\s+([^.!?\n]{2,120})/gi, key: 'stated_preference', confidence: 0.78 },
      { category: 'preferences', regex: /\bmy\s+favorite\s+([^.!?\n]{2,80})/gi, key: 'favorite', confidence: 0.82 },
      { category: 'interests', regex: /\bI(?:'m| am)\s+interested\s+in\s+([^.!?\n]{2,120})/gi, key: 'stated_interest', confidence: 0.8 },
      { category: 'interests', regex: /\bI\s+(?:study|work on|research|follow)\s+([^.!?\n]{2,120})/gi, key: 'activity_interest', confidence: 0.7 },
      { category: 'emotionalState', regex: /\bI(?:'m| am| feel)\s+(happy|sad|anxious|excited|frustrated|stressed|overwhelmed|calm|confident|worried)\b/gi, key: 'self_reported_emotion', confidence: 0.72 },
      { category: 'behavioralPatterns', regex: /\bI\s+(?:usually|often|always|tend to|typically)\s+([^.!?\n]{2,120})/gi, key: 'recurring_behavior', confidence: 0.74 },
    ];

    for (const { category, regex, key, confidence } of patterns) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const value = this.cleanValue(match[1]);
        if (!value) {
          continue;
        }

        fields.push({
          id: uuidv4(),
          category,
          key,
          value,
          evidence: match[0],
          confidence,
          sourceEpisodeIds: [...sourceEpisodeIds],
          traceIds: [...traceIds],
          createdAt: timestamp,
          updatedAt: timestamp,
          lastObservedAt: timestamp,
        });
      }
    }

    return fields;
  }

  private cleanValue(value: string): string {
    return value
      .replace(/\s+/g, ' ')
      .replace(/[,:;\s]+$/g, '')
      .trim();
  }

  private isFieldAllowed(field: UserProfileMemoryField): boolean {
    if (this.privacy.disabledFields.includes(field.category)) {
      return false;
    }

    const fieldKey = `${field.category}.${field.key}`;
    return !this.privacy.disabledFieldKeys.includes(field.key) &&
      !this.privacy.disabledFieldKeys.includes(fieldKey);
  }
}
