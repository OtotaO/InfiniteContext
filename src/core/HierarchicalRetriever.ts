import {
  Chunk,
  HierarchicalMemoryRecord,
  HierarchicalSearchResponse,
  HierarchicalSearchResult,
  HierarchyLevel,
  Vector
} from './types.js';

export interface HierarchicalRetrieverOptions {
  domainK?: number;
  categoryK?: number;
  traceK?: number;
  episodeK?: number;
  finalK?: number;
}

interface ScoredRecord {
  record: HierarchicalMemoryRecord;
  score: number;
}

const LEVEL_ZERO_COUNTS: Record<HierarchyLevel, number> = {
  [HierarchyLevel.DOMAIN]: 0,
  [HierarchyLevel.CATEGORY]: 0,
  [HierarchyLevel.MEMORY_TRACE]: 0,
  [HierarchyLevel.EPISODE]: 0
};

/**
 * Builds H-MEM style positional indexes and performs routed, top-down retrieval.
 */
export class HierarchicalRetriever {
  private recordsById = new Map<string, HierarchicalMemoryRecord>();
  private recordsByLevel: Record<HierarchyLevel, HierarchicalMemoryRecord[]> = {
    [HierarchyLevel.DOMAIN]: [],
    [HierarchyLevel.CATEGORY]: [],
    [HierarchyLevel.MEMORY_TRACE]: [],
    [HierarchyLevel.EPISODE]: []
  };
  private flatEpisodes: HierarchicalMemoryRecord[] = [];

  constructor(chunks: Chunk[] = []) {
    if (chunks.length > 0) {
      this.rebuild(chunks);
    }
  }

  public rebuild(chunks: Chunk[]): void {
    this.recordsById.clear();
    this.recordsByLevel = {
      [HierarchyLevel.DOMAIN]: [],
      [HierarchyLevel.CATEGORY]: [],
      [HierarchyLevel.MEMORY_TRACE]: [],
      [HierarchyLevel.EPISODE]: []
    };
    this.flatEpisodes = [];

    const domainChildren = new Map<string, Set<string>>();
    const categoryChildren = new Map<string, Set<string>>();
    const traceChildren = new Map<string, Set<string>>();
    const domainVectors = new Map<string, Vector[]>();
    const categoryVectors = new Map<string, Vector[]>();
    const traceVectors = new Map<string, Vector[]>();

    for (const chunk of chunks) {
      const domain = chunk.metadata.domain || 'default';
      const category = (chunk.metadata.category as string | undefined) || chunk.metadata.tags[0] || 'uncategorized';
      const trace = (chunk.metadata.memoryTraceId as string | undefined)
        || (chunk.metadata.traceId as string | undefined)
        || (chunk.metadata.source as string | undefined)
        || 'default-trace';

      const domainId = this.makeId(HierarchyLevel.DOMAIN, [domain]);
      const categoryId = this.makeId(HierarchyLevel.CATEGORY, [domain, category]);
      const traceId = this.makeId(HierarchyLevel.MEMORY_TRACE, [domain, category, trace]);
      const episodeId = chunk.id;

      this.addToSet(domainChildren, domainId, categoryId);
      this.addToSet(categoryChildren, categoryId, traceId);
      this.addToSet(traceChildren, traceId, episodeId);
      this.addVector(domainVectors, domainId, chunk.embedding);
      this.addVector(categoryVectors, categoryId, chunk.embedding);
      this.addVector(traceVectors, traceId, chunk.embedding);

      chunk.metadata.hierarchyLevel = HierarchyLevel.EPISODE;
      chunk.metadata.parentId = traceId;
      chunk.metadata.childIds = chunk.metadata.childIds || [];
      chunk.hierarchy = {
        level: HierarchyLevel.EPISODE,
        parentId: traceId,
        childIds: [],
        path: [domainId, categoryId, traceId, episodeId]
      };

      this.upsertRecord({
        id: episodeId,
        level: HierarchyLevel.EPISODE,
        label: chunk.content.slice(0, 80) || episodeId,
        embedding: chunk.embedding,
        parentId: traceId,
        childIds: [],
        metadata: { ...chunk.metadata },
        chunk
      });
    }

    for (const [id, vectors] of domainVectors) {
      const label = id.split(':').slice(1).join(':');
      this.upsertRecord({
        id,
        level: HierarchyLevel.DOMAIN,
        label,
        embedding: this.average(vectors),
        childIds: [...(domainChildren.get(id) || [])],
        metadata: { hierarchyLevel: HierarchyLevel.DOMAIN }
      });
    }

    for (const [id, vectors] of categoryVectors) {
      const parts = id.split(':').slice(1).join(':').split('/');
      const parentId = this.makeId(HierarchyLevel.DOMAIN, [parts[0]]);
      this.upsertRecord({
        id,
        level: HierarchyLevel.CATEGORY,
        label: parts[1] || id,
        embedding: this.average(vectors),
        parentId,
        childIds: [...(categoryChildren.get(id) || [])],
        metadata: { hierarchyLevel: HierarchyLevel.CATEGORY }
      });
    }

    for (const [id, vectors] of traceVectors) {
      const parts = id.split(':').slice(1).join(':').split('/');
      const parentId = this.makeId(HierarchyLevel.CATEGORY, [parts[0], parts[1]]);
      this.upsertRecord({
        id,
        level: HierarchyLevel.MEMORY_TRACE,
        label: parts[2] || id,
        embedding: this.average(vectors),
        parentId,
        childIds: [...(traceChildren.get(id) || [])],
        metadata: { hierarchyLevel: HierarchyLevel.MEMORY_TRACE }
      });
    }

    this.flatEpisodes = this.recordsByLevel[HierarchyLevel.EPISODE];
  }

  public search(queryVector: Vector, options: HierarchicalRetrieverOptions = {}): HierarchicalSearchResponse {
    if (this.flatEpisodes.length === 0) {
      return this.emptyResponse('hierarchical');
    }

    const domainK = options.domainK ?? 3;
    const categoryK = options.categoryK ?? 3;
    const traceK = options.traceK ?? 3;
    const episodeK = options.episodeK ?? 10;
    const finalK = options.finalK ?? episodeK;

    const counts = { ...LEVEL_ZERO_COUNTS };
    const domains = this.topK(this.recordsByLevel[HierarchyLevel.DOMAIN], queryVector, domainK);
    counts[HierarchyLevel.DOMAIN] = this.recordsByLevel[HierarchyLevel.DOMAIN].length;

    const categories = this.routeChildren(domains, queryVector, categoryK, counts, HierarchyLevel.CATEGORY);
    const traces = this.routeChildren(categories, queryVector, traceK, counts, HierarchyLevel.MEMORY_TRACE);
    const episodes = this.routeChildren(traces, queryVector, episodeK, counts, HierarchyLevel.EPISODE);

    const results = episodes
      .filter((episode): episode is ScoredRecord & { record: HierarchicalMemoryRecord & { chunk: Chunk } } => !!episode.record.chunk)
      .map(({ record, score }) => ({
        chunk: record.chunk,
        score,
        path: this.pathFor(record.id, queryVector)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, finalK);

    return {
      results,
      stats: {
        mode: 'hierarchical',
        flatCandidateCount: this.flatEpisodes.length,
        routedCandidateCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
        candidatesByLevel: counts
      }
    };
  }

  public flatSearch(queryVector: Vector, k: number = 10): HierarchicalSearchResponse {
    const results = this.topK(this.flatEpisodes, queryVector, k)
      .filter((episode): episode is ScoredRecord & { record: HierarchicalMemoryRecord & { chunk: Chunk } } => !!episode.record.chunk)
      .map(({ record, score }) => ({
        chunk: record.chunk,
        score,
        path: this.pathFor(record.id, queryVector)
      }));

    return {
      results,
      stats: {
        mode: 'flat',
        flatCandidateCount: this.flatEpisodes.length,
        routedCandidateCount: this.flatEpisodes.length,
        candidatesByLevel: {
          ...LEVEL_ZERO_COUNTS,
          [HierarchyLevel.EPISODE]: this.flatEpisodes.length
        }
      }
    };
  }

  private routeChildren(
    parents: ScoredRecord[],
    queryVector: Vector,
    k: number,
    counts: Record<HierarchyLevel, number>,
    childLevel: HierarchyLevel
  ): ScoredRecord[] {
    const scopedChildren = parents.flatMap(({ record }) => record.childIds)
      .map(id => this.recordsById.get(id))
      .filter((record): record is HierarchicalMemoryRecord => !!record && record.level === childLevel);

    counts[childLevel] += scopedChildren.length;
    return this.topK(scopedChildren, queryVector, k * Math.max(1, parents.length));
  }

  private topK(records: HierarchicalMemoryRecord[], queryVector: Vector, k: number): ScoredRecord[] {
    return records
      .map(record => ({ record, score: this.cosine(queryVector, record.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  private pathFor(recordId: string, queryVector: Vector): HierarchicalSearchResult['path'] {
    const path: HierarchicalSearchResult['path'] = [];
    let current = this.recordsById.get(recordId);

    while (current) {
      path.unshift({
        id: current.id,
        label: current.label,
        level: current.level,
        score: this.cosine(queryVector, current.embedding)
      });
      current = current.parentId ? this.recordsById.get(current.parentId) : undefined;
    }

    return path;
  }

  private upsertRecord(record: HierarchicalMemoryRecord): void {
    this.recordsById.set(record.id, record);
    this.recordsByLevel[record.level].push(record);
  }

  private makeId(level: HierarchyLevel, parts: string[]): string {
    return `${level}:${parts.map(part => encodeURIComponent(part)).join('/')}`;
  }

  private addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
    const set = map.get(key) || new Set<string>();
    set.add(value);
    map.set(key, set);
  }

  private addVector(map: Map<string, Vector[]>, key: string, vector: Vector): void {
    const vectors = map.get(key) || [];
    vectors.push(vector);
    map.set(key, vectors);
  }

  private average(vectors: Vector[]): Vector {
    if (vectors.length === 0) return [];
    const sums = Array(vectors[0].length).fill(0);
    for (const vector of vectors) {
      vector.forEach((value, index) => {
        sums[index] += value;
      });
    }
    return sums.map(sum => sum / vectors.length);
  }

  private cosine(a: Vector, b: Vector): number {
    if (a.length !== b.length || a.length === 0) return Number.NEGATIVE_INFINITY;
    const dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
    const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
    const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
    return normA === 0 || normB === 0 ? Number.NEGATIVE_INFINITY : dot / (normA * normB);
  }

  private emptyResponse(mode: 'flat' | 'hierarchical'): HierarchicalSearchResponse {
    return {
      results: [],
      stats: {
        mode,
        flatCandidateCount: 0,
        routedCandidateCount: 0,
        candidatesByLevel: { ...LEVEL_ZERO_COUNTS }
      }
    };
  }
}
