#!/usr/bin/env node
/**
 * Retrieval benchmark: exact flat (brute-force cosine) vs. approximate HNSW.
 *
 * Measures, for synthetic random unit vectors at increasing corpus sizes:
 *   - recall@k of HNSW against the exact flat top-k (the ground truth)
 *   - per-query latency p50 / p95 for both indexes
 *
 * The flat index mirrors the exact cosine scoring used by
 * src/core/VectorStore.ts (normalized dot product). The approximate index uses
 * hnswlib-node with the same cosine space, which is already a project
 * dependency. No network or API keys are required.
 *
 * Run:  npm run bench:retrieval
 * Or:   node scripts/retrieval-benchmark.mjs [--sizes 1000,10000,100000] [--dim 128] [--k 10] [--queries 200]
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const hnswlib = require('hnswlib-node');

// ---------------------------------------------------------------------------
// Config (overridable via CLI flags)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { sizes: [1000, 10000, 100000], dim: 128, k: 10, queries: 200, seed: 1337 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sizes') args.sizes = argv[++i].split(',').map(Number);
    else if (a === '--dim') args.dim = Number(argv[++i]);
    else if (a === '--k') args.k = Number(argv[++i]);
    else if (a === '--queries') args.queries = Number(argv[++i]);
    else if (a === '--seed') args.seed = Number(argv[++i]);
  }
  return args;
}

// HNSW build/query parameters (typical defaults for ANN benchmarks).
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 200;
const HNSW_EF_SEARCH = 100;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so numbers are reproducible across runs.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random unit vector (L2-normalized) using a Float32Array.
function randomUnitVector(rand, dim) {
  const v = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    // Box-Muller for an approx. Gaussian -> uniform direction on the sphere.
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    v[i] = g;
    norm += g * g;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

// ---------------------------------------------------------------------------
// Exact flat search: cosine similarity == dot product for unit vectors.
// Returns the labels of the top-k highest-scoring stored vectors.
// ---------------------------------------------------------------------------
function flatTopK(corpus, dim, query, k) {
  const n = corpus.length / dim;
  // Maintain a small top-k via insertion (k is tiny relative to n).
  const bestScore = new Array(k).fill(-Infinity);
  const bestLabel = new Array(k).fill(-1);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    let s = 0;
    for (let d = 0; d < dim; d++) s += corpus[base + d] * query[d];
    if (s > bestScore[k - 1]) {
      // Insert into the sorted top-k array.
      let j = k - 1;
      while (j > 0 && bestScore[j - 1] < s) {
        bestScore[j] = bestScore[j - 1];
        bestLabel[j] = bestLabel[j - 1];
        j--;
      }
      bestScore[j] = s;
      bestLabel[j] = i;
    }
  }
  return bestLabel;
}

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}

function summarizeLatency(samplesNs) {
  const ms = samplesNs.map((n) => Number(n) / 1e6).sort((a, b) => a - b);
  return { p50: percentile(ms, 50), p95: percentile(ms, 95) };
}

// ---------------------------------------------------------------------------
// Benchmark one corpus size.
// ---------------------------------------------------------------------------
function benchSize(N, cfg) {
  const { dim, k, queries, seed } = cfg;
  const rand = mulberry32(seed + N);

  // Build the flat corpus as a single contiguous Float32Array.
  const corpus = new Float32Array(N * dim);
  const hnsw = new hnswlib.HierarchicalNSW('cosine', dim);
  hnsw.initIndex(N, HNSW_M, HNSW_EF_CONSTRUCTION);

  const buildStart = process.hrtime.bigint();
  const tmp = new Float32Array(dim);
  for (let i = 0; i < N; i++) {
    const v = randomUnitVector(rand, dim);
    corpus.set(v, i * dim);
    // hnswlib wants a plain array.
    hnsw.addPoint(Array.from(v), i);
  }
  void tmp;
  const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
  hnsw.setEf(HNSW_EF_SEARCH);

  // Generate query set (held out from the corpus PRNG stream).
  const qrand = mulberry32(seed * 31 + N);
  const queryVecs = [];
  for (let q = 0; q < queries; q++) queryVecs.push(randomUnitVector(qrand, dim));

  const flatLatNs = [];
  const hnswLatNs = [];
  let recallHits = 0;
  const recallDenom = queries * k;

  for (let q = 0; q < queries; q++) {
    const query = queryVecs[q];
    const queryArr = Array.from(query);

    let t0 = process.hrtime.bigint();
    const flatLabels = flatTopK(corpus, dim, query, k);
    flatLatNs.push(process.hrtime.bigint() - t0);

    t0 = process.hrtime.bigint();
    const { neighbors } = hnsw.searchKnn(queryArr, k);
    hnswLatNs.push(process.hrtime.bigint() - t0);

    // recall@k = |HNSW topk ∩ flat topk| / k
    const truth = new Set(flatLabels);
    for (const label of neighbors) if (truth.has(label)) recallHits++;
  }

  return {
    N,
    buildMs,
    recallAtK: recallHits / recallDenom,
    flat: summarizeLatency(flatLatNs),
    hnsw: summarizeLatency(hnswLatNs),
  };
}

function fmt(n, digits = 3) {
  return Number(n).toFixed(digits);
}

function main() {
  const cfg = parseArgs(process.argv.slice(2));
  console.log('InfiniteContext retrieval benchmark');
  console.log(
    `dim=${cfg.dim}  k=${cfg.k}  queries=${cfg.queries}  metric=cosine  ` +
      `HNSW(M=${HNSW_M}, efConstruction=${HNSW_EF_CONSTRUCTION}, efSearch=${HNSW_EF_SEARCH})`
  );
  console.log(`node=${process.version}  platform=${process.platform}/${process.arch}`);
  console.log('');

  const rows = [];
  for (const N of cfg.sizes) {
    process.stderr.write(`Running N=${N} ...\n`);
    rows.push(benchSize(N, cfg));
  }

  // Markdown table to stdout for easy copy into results doc.
  const header =
    '| corpus N | build (ms) | recall@' +
    cfg.k +
    ' | flat p50 (ms) | flat p95 (ms) | HNSW p50 (ms) | HNSW p95 (ms) | speedup p50 |';
  const sep = '| --- | --- | --- | --- | --- | --- | --- | --- |';
  console.log(header);
  console.log(sep);
  for (const r of rows) {
    const speedup = r.hnsw.p50 > 0 ? r.flat.p50 / r.hnsw.p50 : Infinity;
    console.log(
      `| ${r.N.toLocaleString('en-US')} | ${fmt(r.buildMs, 0)} | ${fmt(r.recallAtK, 3)} | ` +
        `${fmt(r.flat.p50)} | ${fmt(r.flat.p95)} | ${fmt(r.hnsw.p50)} | ${fmt(r.hnsw.p95)} | ` +
        `${fmt(speedup, 1)}x |`
    );
  }
}

main();
