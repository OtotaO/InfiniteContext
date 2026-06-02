import {
  Chunk,
  HierarchicalMemoryRecord,
  HierarchicalSearchResponse,
  HierarchicalSearchResult,
  HierarchyLevel,
  Vector
} from './types.js';
/**
 * Dataset size at/above which the flat episode scan switches to an approximate
 * (HNSW) index. Below this an exact linear scan is both fast and more accurate,
 * so the ANN overhead isn't worth it.
 */
export const DEFAULT_ANN_THRESHOLD = 2_000;

// Memoized native-module load. Dynamic import keeps this working under both the
// ESM build and the CommonJS test transform; resolves to null when unavailable.
let hnswModulePromise: Promise<any | null> | undefined;
function loadHnswAsync(): Promise<any | null> {
  if (!hnswModulePromise) {
    hnswModulePromise = import('hnswlib-node')
      .then((mod: any) => {
        const lib = mod?.HierarchicalNSW ? mod : mod?.default;
        return lib?.HierarchicalNSW ? lib : null;
      })
      .catch(() => null);
  }
  return hnswModulePromise;
}

interface EpisodeAnnIndex {
  index: any;
  // label i corresponds to records[i]
  records: HierarchicalMemoryRecord[];
  dimension: number;
}

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
  private episodeAnn: EpisodeAnnIndex | null = null;
  private readonly annThreshold: number;
  // The ANN graph is built asynchronously (native module loaded via dynamic
  // import); flat search uses the exact scan until it is ready.
  private annReady: Promise<void> = Promise.resolve();
  private annGeneration = 0;

  constructor(chunks: Chunk[] = [], options: { annThreshold?: number } = {}) {
    this.annThreshold = options.annThreshold ?? DEFAULT_ANN_THRESHOLD;
    if (chunks.length > 0) {
      this.rebuild(chunks);
    }
  }

  /** Resolves once the approximate index build for the latest rebuild settles. */
  public async ready(): Promise<void> {
    await this.annReady;
  }

  /** Whether the flat episode scan is currently served by the approximate index. */
  public usesApproximateEpisodeIndex(): boolean {
    return this.episodeAnn !== null;
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
    this.episodeAnn = null;
    const generation = ++this.annGeneration;
    this.annReady = this.buildEpisodeAnnIndex(this.flatEpisodes, generation);
  }

  /**
   * Build an approximate (HNSW) index over episode embeddings for sub-linear
   * flat retrieval. Leaves `episodeAnn` null (falling back to an exact scan)
   * when the dataset is small, the native module is unavailable, or embeddings
   * have an inconsistent/empty dimension. A generation guard prevents a slow
   * build from clobbering a newer rebuild.
   */
  private async buildEpisodeAnnIndex(episodes: HierarchicalMemoryRecord[], generation: number): Promise<void> {
    if (episodes.length < this.annThreshold) {
      return;
    }

    const dimension = episodes[0].embedding.length;
    if (dimension === 0 || episodes.some(episode => episode.embedding.length !== dimension)) {
      return;
    }

    const hnsw = await loadHnswAsync();
    if (!hnsw || generation !== this.annGeneration) {
      return;
    }

    try {
      const index = new hnsw.HierarchicalNSW('cosine', dimension);
      index.initIndex(episodes.length, 16, 200);
      episodes.forEach((episode, label) => index.addPoint(episode.embedding, label));
      if (generation !== this.annGeneration) {
        return;
      }
      this.episodeAnn = { index, records: episodes, dimension };
    } catch {
      // Any native failure degrades to the exact scan.
    }
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
    const scored = this.episodeAnn
      ? this.annTopK(this.episodeAnn, queryVector, k)
      : this.topK(this.flatEpisodes, queryVector, k);

    const results = scored
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

  /**
   * Approximate top-K over the episode HNSW index. Falls back to the exact scan
   * if the query dimension doesn't match or the native query throws.
   */
  private annTopK(ann: EpisodeAnnIndex, queryVector: Vector, k: number): ScoredRecord[] {
    if (queryVector.length !== ann.dimension) {
      return this.topK(this.flatEpisodes, queryVector, k);
    }

    const limit = Math.min(k, ann.records.length);
    if (limit <= 0) {
      return [];
    }

    try {
      // Widen the search beam beyond k for better recall.
      ann.index.setEf(Math.max(limit * 4, 64));
      const { neighbors, distances } = ann.index.searchKnn(queryVector, limit);
      return neighbors
        .map((label: number, i: number) => ({
          record: ann.records[label],
          // cosine space distance is 1 - cosine similarity
          score: 1 - distances[i],
        }))
        .filter((scored: ScoredRecord) => !!scored.record);
    } catch {
      return this.topK(this.flatEpisodes, queryVector, k);
    }
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
