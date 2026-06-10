# ADR 0002 — Tamper-evident governance receipts

- Status: Accepted
- Date: 2026-06-10

## Context

ADR 0001 gave profile memories a single governance contract: redaction,
deletion (with tombstones), and export all flow through one safety pipeline.
Those operations now also survive a restart (profile memories are persisted in
the manifest).

What was still missing is **evidence**. A memory system that handles personal
data is routinely asked to *prove* it honoured a deletion or a data-subject
access request — "show me that you erased it, and that the record wasn't
quietly altered afterwards." Mutable state in a manifest cannot answer that:
anyone with disk access could edit history and nothing would look amiss.

The sibling project [OtotaO/SUM](https://github.com/OtotaO/SUM) solves the
analogous problem for text transformations with **signed attestation
receipts** — Ed25519 signatures over canonical bytes, verifiable byte-identically
across runtimes. Its governed operations are prose↔axiom transforms; ours are
memory deletion / redaction / export. The model transfers directly.

## Decision

Every governed mutation (`deleteMemories`, `redactMemories`) and every `exportMemories`
emits an **append-only, signed governance receipt**.

- **Signing**: Ed25519 via Node's built-in `crypto` (no external dependency,
  Node 18.4+). Each `MemoryManager` instance holds a keypair persisted at
  `<basePath>/governance/signing-key.pem` (mode `0600`), generated on first run.
- **Canonicalization**: a JCS-style, key-sorted serialization so logically equal
  payloads always produce identical signing bytes.
- **Receipt payload** (`infinitecontext.governance_receipt.v1`): operation,
  timestamp, reason, matched/changed counts, the affected record ids with
  before/after content hashes, and `prev` — the hash of the previous receipt.
  The `prev` link makes the receipts a hash chain, so tampering with any past
  receipt invalidates every receipt after it.
- **Storage**: receipts are persisted in the manifest and reloaded on restart;
  the signing key persists alongside, so old receipts keep verifying.
- **API**: `getGovernanceReceipts()`, `getSigningPublicJwk()` (public material
  for offline verification), `verifyGovernanceReceipt()`, and
  `verifyGovernanceReceiptChain()`.

## Trust boundary

Following SUM's "proof boundary" doctrine, a receipt attests that **the operation
occurred and was signed by the holder of a given key at a given time**. It does
*not* assert anything about the truthfulness of content, and its tamper-evidence
is rooted in the signing key's public material — an attacker who obtains the
private key can forge a consistent chain. Publishing the public JWK (e.g. via a
`.well-known/jwks.json`) out-of-band is what gives a third party something to
verify against. Content-level fact-preservation (SUM's NLI auditing) is a
deliberately separate concern and out of scope here.

## Consequences

- Deletion and export become *provable*, strengthening the ADR 0001 contract.
- One new on-disk secret (the signing key) per instance, with the usual key-loss
  caveat: lose it and historical receipts can no longer be verified (though their
  content remains in the manifest).
- In-place incremental deletes and key rotation are natural follow-ups.
