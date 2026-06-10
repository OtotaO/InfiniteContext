/**
 * Tamper-evident governance receipts for InfiniteContext.
 *
 * Adopted from the OtotaO/SUM attestation model: governed transformations emit a
 * signed receipt over canonical bytes so an operation can be independently
 * verified later. Here the governed operations are memory deletion, redaction,
 * and export (ADR 0001).
 *
 * Trust boundary (per SUM's "proof boundary" doctrine): a receipt attests that
 * the operation occurred and was signed by the holder of a given key at a given
 * time. It does NOT assert anything about the truthfulness of content. Trust is
 * rooted in the signing key's public material (see {@link ReceiptSigner.publicJwk}).
 *
 * Zero external dependencies: uses Node's built-in Ed25519 (Node 18.4+).
 */

import {
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createHash,
  createPublicKey,
  createPrivateKey,
  KeyObject,
  type JsonWebKey,
} from 'crypto';

export type GovernanceOperation = 'redact' | 'delete' | 'export';

export interface ReceiptAffectedRecord {
  id: string;
  type: 'chunk' | 'profile-memory' | 'user-profile';
  /** Hash of the record's content before the operation. */
  beforeHash: string;
  /** Hash of the record's content after the operation (omitted for export). */
  afterHash?: string;
}

export interface ReceiptPayload {
  schema: 'infinitecontext.governance_receipt.v1';
  operation: GovernanceOperation;
  timestamp: string;
  reason?: string;
  matched: number;
  changed: number;
  affected: ReceiptAffectedRecord[];
  /** Hash of the previous receipt, forming an append-only chain (null for the first). */
  prev: string | null;
}

export interface GovernanceReceipt {
  payload: ReceiptPayload;
  kid: string;
  alg: 'Ed25519';
  /** Detached signature (base64url) over canonicalize(payload). */
  signature: string;
}

/**
 * Deterministic, key-sorted JSON serialization (JCS-style). Object keys are
 * sorted recursively and keys with `undefined` values are dropped, so logically
 * equal payloads always produce byte-identical output regardless of key order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map(item => (item === undefined ? 'null' : canonicalize(item))).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalize(record[key])).join(',') + '}';
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Content hash used for a receipt's before/after fields. */
export function hashContent(input: string): string {
  return sha256Hex(input);
}

/** Stable hash of a whole receipt, used to chain the next receipt's `prev`. */
export function receiptHash(receipt: GovernanceReceipt): string {
  return sha256Hex(canonicalize(receipt));
}

function computeKid(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  return sha256Hex(jwk.x ?? '').slice(0, 16);
}

/**
 * An Ed25519 signing identity that produces {@link GovernanceReceipt}s.
 */
export class ReceiptSigner {
  private constructor(
    private readonly privateKey: KeyObject,
    public readonly publicKey: KeyObject,
    public readonly kid: string,
  ) {}

  /** Generate a fresh signing identity. */
  static generate(): ReceiptSigner {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return new ReceiptSigner(privateKey, publicKey, computeKid(publicKey));
  }

  /** Reconstruct a signer from a persisted PKCS#8 PEM private key. */
  static fromPrivateKeyPem(pem: string): ReceiptSigner {
    const privateKey = createPrivateKey(pem);
    const publicKey = createPublicKey(privateKey);
    return new ReceiptSigner(privateKey, publicKey, computeKid(publicKey));
  }

  /** Export the private key as PKCS#8 PEM for persistence (store with care). */
  exportPrivateKeyPem(): string {
    return this.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  }

  /** Public material for offline verification (JWK + key id). */
  publicJwk(): JsonWebKey & { kid: string } {
    return { ...(this.publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: this.kid };
  }

  /** Sign a payload, producing a detached-signature receipt. */
  sign(payload: ReceiptPayload): GovernanceReceipt {
    const bytes = Buffer.from(canonicalize(payload), 'utf8');
    const signature = edSign(null, bytes, this.privateKey).toString('base64url');
    return { payload, kid: this.kid, alg: 'Ed25519', signature };
  }
}

/**
 * Verify a receipt's signature against a public key (a {@link KeyObject} or a JWK).
 * Returns false on any structural or cryptographic failure.
 */
export function verifyReceipt(receipt: GovernanceReceipt, publicKey: KeyObject | JsonWebKey): boolean {
  try {
    if (receipt.alg !== 'Ed25519') {
      return false;
    }
    const key = publicKey instanceof KeyObject
      ? publicKey
      : createPublicKey({ key: publicKey as JsonWebKey, format: 'jwk' });
    const bytes = Buffer.from(canonicalize(receipt.payload), 'utf8');
    return edVerify(null, bytes, key, Buffer.from(receipt.signature, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * Verify an ordered chain of receipts: every signature is valid and every
 * `prev` correctly references the hash of the preceding receipt. Returns the
 * index of the first broken receipt, or -1 if the whole chain is intact.
 */
export function verifyReceiptChain(receipts: GovernanceReceipt[], publicKey: KeyObject | JsonWebKey): number {
  let prev: string | null = null;
  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i];
    if (receipt.payload.prev !== prev || !verifyReceipt(receipt, publicKey)) {
      return i;
    }
    prev = receiptHash(receipt);
  }
  return -1;
}
