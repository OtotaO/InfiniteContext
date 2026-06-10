# Retrieval benchmark: flat (exact) vs. HNSW (approximate)

This benchmark compares the exact flat cosine search used by
[`src/core/VectorStore.ts`](../src/core/VectorStore.ts) against an approximate
HNSW index ([`hnswlib-node`](https://www.npmjs.com/package/hnswlib-node), already
a project dependency) on synthetic random unit vectors.

It reports, at increasing corpus sizes:

- **recall@k** — fraction of the exact flat top-k that HNSW also returns
  (flat is the ground truth), averaged over the query set.
- **per-query latency p50 / p95** for both indexes.

The script is self-contained: no network access, no API keys, deterministic PRNG
seed for reproducibility.

## Run it

```bash
npm install
npm run bench:retrieval
# or with custom parameters:
node scripts/retrieval-benchmark.mjs --sizes 1000,10000,100000 --dim 128 --k 10 --queries 200
```

## Methodology

- **Vectors:** `dim`-dimensional Gaussian-sampled, L2-normalized (uniform on the
  unit sphere). Cosine similarity therefore equals the dot product.
- **Flat index:** exact brute-force scan scoring every stored vector — the same
  normalized-dot-product cosine scoring that `VectorStore` uses. Used as the
  recall ground truth.
- **HNSW index:** `hnswlib-node` cosine space with `M=16`,
  `efConstruction=200`, `efSearch=100`.
- **Latency:** wall-clock per query via `process.hrtime.bigint()`; p50/p95 over
  the full query set.
- **recall@k:** `|HNSW topk ∩ flat topk| / k`, averaged over all queries.

## Results

Measured run (committed numbers are from this exact configuration):

- `dim=128`, `k=10`, `queries=200`, `metric=cosine`
- `HNSW(M=16, efConstruction=200, efSearch=100)`
- `node=v22.22.2`, `platform=darwin/arm64`

| corpus N | build (ms) | recall@10 | flat p50 (ms) | flat p95 (ms) | HNSW p50 (ms) | HNSW p95 (ms) | speedup p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 105 | 0.995 | 0.113 | 0.127 | 0.084 | 0.095 | 1.3x |
| 10,000 | 3057 | 0.766 | 1.099 | 1.171 | 0.201 | 0.266 | 5.5x |
| 100,000 | 71315 | 0.307 | 11.074 | 11.463 | 0.457 | 0.546 | 24.2x |

## Reading the results

- **Flat latency grows linearly with N** (≈0.11 ms → 11 ms across 1k → 100k),
  exactly as expected for an exhaustive scan. It is the recall=1.0 baseline.
- **HNSW latency stays roughly flat** (sub-millisecond at every size), giving a
  ~24x p50 speedup over exact search at 100k vectors.
- **Recall falls off at scale with these parameters.** Uniformly random
  high-dimensional vectors are an adversarial (near-worst-case) ANN workload:
  neighbors are nearly equidistant, so a fixed `efSearch=100` recovers fewer of
  the true top-k as N grows. Real embedding distributions are far more clustered
  and recover substantially higher recall at the same settings.
- **Recall is tunable.** Raising `efSearch` (and `M`/`efConstruction`) trades
  latency for recall. Re-run with, e.g.,
  `node scripts/retrieval-benchmark.mjs --sizes 100000 --queries 200` after
  bumping `HNSW_EF_SEARCH` in the script to explore the curve.

Numbers are hardware- and parameter-dependent; re-run on your target machine for
representative figures.
