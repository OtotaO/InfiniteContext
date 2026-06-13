# Project Audit — 2026-06

A four-part read-only audit (core, utils, providers/API/CLI, categorization/
summarization/scripts/docs) plus a packaging/CI pass. Findings are tracked here
with status. **Fixed** items have landed; the rest are open.

The through-line: governance was cryptographically sound (signed, chained
receipts) but **operationally hollow** — the operations the receipts attested did
not reach the storage layer. The first fix closes that gap.

## Critical

- [x] **Erasure was not durable — deleted/redacted content resurrected on restart.**
  `mutateMemories` mutated only in-memory `VectorStore` copies; the manifest
  stores only chunk IDs/locations, and the provider blob was never rewritten, so
  `restoreManifestChunk` reloaded the original ACTIVE chunk on restart. **Fixed:**
  mutations now overwrite the on-disk blob in place (`StorageProvider.update`),
  drained on shutdown; redacted/deleted tombstones survive restart; `retrieveChunk`
  is gated by `isRetrievable`. (`MemoryManager.mutateMemories`, `persistChunkMutation`)

## High

- [x] **One redaction broke all flat retrieval.** Redacted chunks have `embedding: []`;
  `VectorStore.search` scored them and threw "Vectors must have the same dimension".
  **Fixed:** search excludes DELETED/REDACTED and guards on embedding dimension;
  `addChunk` tolerates empty-embedding tombstones; the hierarchical retriever indexes
  only retrievable, non-empty-embedding chunks.
- [ ] **`MemoryManager.retrieveChunk` was an ungoverned read path** (returned raw blobs
  with no lifecycle filter). Partially closed by the `isRetrievable` gate above;
  revisit once `retrieveChunk` is confirmed unused by other surfaces.
- [ ] **Path traversal in `BackupManager`** — unsanitized `backupId` joined into paths
  feeding `fs.rm(recursive, force)` via public `deleteBackup`/`recoverFromBackup`.
  (`BackupManager.ts:412,527`)
- [ ] **Path traversal in `LocalStorageProvider`** — `retrieve`/`exists`/`delete` join
  unvalidated `location.key` into `basePath`. (`LocalStorageProvider.ts`)
- [ ] **`recoverFromBackup({overwriteExisting})` destroys live data** with no safety copy
  and a no-op rollback; failure surfaces only as `false`. (`BackupManager.ts:262-287`)
- [ ] **`removeBucket` never invalidates the cached retriever** — removed buckets' chunks
  remain retrievable until an unrelated mutation. (`MemoryManager.ts`)
- [ ] **Every chunk mutation forces a full retriever + HNSW rebuild** (no `markDelete`,
  no incremental delete). (`HierarchicalRetriever`)
- [ ] **Backup re-redacts already-redacted chunks**, invalidating their stored hash so
  restored chunks fail integrity checks; DELETED is downgraded to REDACTED.
- [ ] **Integrity verification is theater** — backup hash covers only `metadata.json`;
  export chunk hashes are never checked on import and get re-stamped over tampered
  content. (`BackupManager.ts:172`, `DataPortability.ts:166`)
- [ ] **Adaptive learning is dead on arrival** — feedback keyed by `"name/domain"` can
  never match category UUIDs. (`index.ts` vs `AdaptiveStrategy.ts`)
- [ ] **llamafile build produces a broken artifact** — `dependencies: {}` bundles nothing;
  wrapper runs the library entry, not `cli.js`. (`scripts/build-llamafile.js`)
- [ ] **Failed Google Drive connect is silently swallowed** — writes fall back to local
  disk with no alert. (`index.ts` + `GoogleDriveProvider.ts`)

## Medium (selected)

- [ ] CSV export/import round-trip broken (unescaped delimiters, newline-shattering
  split, `split(':',2)` truncation, dropped `deletionStatus`/`hash`/`sensitivity`).
- [ ] `importChunks` reports success while persisting nothing (no manager passed).
- [ ] Main search path ignores memory lifecycle (decay/stale/rebut/expiry) — applied in
  `VectorStore.search` but not the hierarchical path.
- [ ] Leaked test handle = ErrorHandler's never-closed winston `File` transports.
- [ ] World-readable (0644) chunk blobs and `manifest.json` (plaintext profile memories).
- [ ] Unattested profile deletion; profile redaction orphans the unredacted blob.
- [ ] `VectorStore.search`/`getChunk` return live internal references (clone invariant).
- [ ] Constructor silently ignores `categorizerOptions`/`googleDriveCredentials`/`defaultThresholds`.
- [ ] Inverted `CategoryCache` eviction; unbounded keyword scores short-circuit semantics.
- [ ] Manifest-write failure misclassified as provider failure → duplicate orphan blobs.
- [ ] Partial LLM summarization yields duplicate level keys; empty input pushes `undefined`.
- [ ] Docs drift: ARCHITECTURE.md omits governance/profile/negation/hierarchical subsystems.

## Packaging / hygiene

- [ ] `npm pack`/`publish` broken by `prepare: lefthook install` (use `|| exit 0`).
- [ ] ~15 of 22 runtime deps never imported (`mongodb`, `sqlite3`, `express`, `fastify`,
  `ioredis`, …) — source of most of the 16 high `npm audit` vulns.
- [ ] No `files` field — a publish ships tests/docs/scripts.
- [ ] `lint` script with no eslint config; several utils modules lack dedicated tests.
