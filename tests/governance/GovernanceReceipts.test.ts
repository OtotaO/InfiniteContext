import {
  ReceiptSigner,
  canonicalize,
  verifyReceipt,
  verifyReceiptChain,
  receiptHash,
  GovernanceReceipt,
  ReceiptPayload,
} from '../../src/governance/GovernanceReceipts.js';

function payload(prev: string | null, changed = 1): ReceiptPayload {
  return {
    schema: 'infinitecontext.governance_receipt.v1',
    operation: 'delete',
    timestamp: '2026-06-10T00:00:00.000Z',
    matched: changed,
    changed,
    affected: [{ id: 'c1', type: 'chunk', beforeHash: 'a', afterHash: 'b' }],
    prev,
  };
}

describe('GovernanceReceipts', () => {
  describe('canonicalize', () => {
    it('is independent of object key order', () => {
      expect(canonicalize({ b: 1, a: [3, { y: 1, x: 2 }] }))
        .toBe(canonicalize({ a: [3, { x: 2, y: 1 }], b: 1 }));
    });

    it('drops undefined-valued keys', () => {
      expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    });
  });

  describe('sign / verify', () => {
    it('round-trips a valid signature', () => {
      const signer = ReceiptSigner.generate();
      const receipt = signer.sign(payload(null));
      expect(verifyReceipt(receipt, signer.publicKey)).toBe(true);
      // Also verifiable from the exported public JWK alone (offline verification).
      expect(verifyReceipt(receipt, signer.publicJwk())).toBe(true);
    });

    it('rejects a tampered payload', () => {
      const signer = ReceiptSigner.generate();
      const receipt = signer.sign(payload(null));
      const tampered: GovernanceReceipt = {
        ...receipt,
        payload: { ...receipt.payload, changed: 999 },
      };
      expect(verifyReceipt(tampered, signer.publicKey)).toBe(false);
    });

    it('rejects a signature from a different key', () => {
      const signer = ReceiptSigner.generate();
      const other = ReceiptSigner.generate();
      const receipt = signer.sign(payload(null));
      expect(verifyReceipt(receipt, other.publicKey)).toBe(false);
    });

    it('survives a private-key export/import round trip', () => {
      const signer = ReceiptSigner.generate();
      const restored = ReceiptSigner.fromPrivateKeyPem(signer.exportPrivateKeyPem());
      expect(restored.kid).toBe(signer.kid);
      const receipt = restored.sign(payload(null));
      expect(verifyReceipt(receipt, signer.publicKey)).toBe(true);
    });
  });

  describe('chain verification', () => {
    it('accepts a correctly linked chain and locates breaks', () => {
      const signer = ReceiptSigner.generate();
      const first = signer.sign(payload(null));
      const second = signer.sign(payload(receiptHash(first), 2));
      expect(verifyReceiptChain([first, second], signer.publicKey)).toBe(-1);

      // Reordering breaks the prev linkage at index 0.
      expect(verifyReceiptChain([second, first], signer.publicKey)).toBe(0);
    });
  });
});
