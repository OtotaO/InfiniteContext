import { SummarizationEngine } from '../../src/summarization/SummarizationEngine.js';

const sampleText =
  'InfiniteContext stores long-term memories as vectors. ' +
  'It retrieves them by similarity. ' +
  'Governance controls keep the data safe. ' +
  'Summaries condense each chunk.';

describe('SummarizationEngine', () => {
  describe('extractive mode (no LLM client)', () => {
    it('produces one summary per requested level with concepts', async () => {
      const engine = new SummarizationEngine();
      const summaries = await engine.summarize(sampleText, 3);
      expect(summaries).toHaveLength(3);
      expect(summaries[0].level).toBe(1);
      // Every level yields real, non-empty content and a concept list.
      for (const summary of summaries) {
        expect(summary.content.length).toBeGreaterThan(0);
        expect(Array.isArray(summary.concepts)).toBe(true);
      }
    });
  });

  describe('LLM mode', () => {
    it('calls chat.completions.create and uses the returned content', async () => {
      const calls: any[] = [];
      const fakeClient = {
        chat: {
          completions: {
            create: async (req: any) => {
              calls.push(req);
              return { choices: [{ message: { content: 'LLM summary.' } }] };
            },
          },
        },
      };

      const engine = new SummarizationEngine(fakeClient, { model: 'test-model' });
      const summaries = await engine.summarize(sampleText, 1);

      expect(summaries[0].content).toBe('LLM summary.');
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0].model).toBe('test-model');
      expect(calls[0].messages[calls[0].messages.length - 1].content).toContain(sampleText);
    });

    it('falls back to extractive summaries when the LLM call fails', async () => {
      const fakeClient = {
        chat: { completions: { create: async () => { throw new Error('rate limited'); } } },
      };
      const engine = new SummarizationEngine(fakeClient);
      const summaries = await engine.summarize(sampleText, 2);
      expect(summaries).toHaveLength(2);
      expect(summaries[0].content).not.toContain('LLM');
      expect(summaries[0].content.length).toBeGreaterThan(0);
    });
  });
});
