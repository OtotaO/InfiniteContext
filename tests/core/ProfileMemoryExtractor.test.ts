import { describe, expect, it } from '@jest/globals';
import { ProfileMemoryExtractor } from '../../src/core/ProfileMemoryExtractor.js';

describe('ProfileMemoryExtractor', () => {
  it('extracts profile memories with source episode and trace links', () => {
    const extractor = new ProfileMemoryExtractor();

    const profile = extractor.extractProfileMemory({
      content: 'I prefer concise answers. I am interested in robotics. I usually work late.',
      userId: 'user-1',
      episodeId: 'episode-1',
      traceId: 'trace-1',
      timestamp: '2026-05-28T00:00:00.000Z',
    });

    expect(profile).not.toBeNull();
    expect(profile?.sourceEpisodeIds).toEqual(['episode-1']);
    expect(profile?.traceIds).toEqual(['trace-1']);
    expect(profile?.preferences[0].value).toBe('concise answers');
    expect(profile?.interests[0].value).toBe('robotics');
    expect(profile?.behavioralPatterns[0].value).toBe('work late');
  });

  it('honors disabled profile fields', () => {
    const extractor = new ProfileMemoryExtractor({
      profilePrivacy: {
        disabledFields: ['emotionalState'],
      },
    });

    const profile = extractor.extractProfileMemory({
      content: 'I feel anxious. I prefer bullet lists.',
    });

    expect(profile?.emotionalState).toEqual([]);
    expect(profile?.preferences[0].value).toBe('bullet lists');
  });
});
