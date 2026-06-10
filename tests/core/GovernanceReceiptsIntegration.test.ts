import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MemoryManager } from '../../src/core/MemoryManager.js';
import { verifyReceiptChain } from '../../src/governance/GovernanceReceipts.js';

const embeddingFunction = async (text: string): Promise<number[]> => [text.length || 1, 1, 0];

describe('governance receipts in MemoryManager', () => {
  it('emits a signed, verifiable receipt for deletion and chains it', async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-receipts-'));
    try {
      const manager = new MemoryManager({ basePath, embeddingFunction });
      await manager.initialize({ localStoragePath: path.join(basePath, 'storage') });

      const bucket = manager.createBucket({ name: 'notes', domain: 'personal' });
      const chunk = await manager.createChunk('sensitive note', { domain: 'personal', source: 'test', tags: [] });
      bucket.addChunk(chunk);

      const result = manager.deleteMemories({}, 'user erasure request');
      expect(result.changed).toBe(1);

      const receipts = manager.getGovernanceReceipts();
      expect(receipts).toHaveLength(1);
      const receipt = receipts[0];
      expect(receipt.payload.operation).toBe('delete');
      expect(receipt.payload.reason).toBe('user erasure request');
      expect(receipt.payload.affected.map(a => a.id)).toContain(chunk.id);
      expect(receipt.payload.prev).toBeNull();

      // Verifiable against the instance key, and the chain is intact.
      expect(manager.verifyGovernanceReceipt(receipt)).toBe(true);
      expect(manager.verifyGovernanceReceiptChain()).toBe(-1);

      // An export adds a second, correctly chained receipt.
      manager.exportMemories({ includeDeleted: true });
      const after = manager.getGovernanceReceipts();
      expect(after.length).toBe(2);
      expect(after[1].payload.operation).toBe('export');
      expect(manager.verifyGovernanceReceiptChain()).toBe(-1);

      await manager.shutdown();
    } finally {
      await fs.rm(basePath, { recursive: true, force: true });
    }
  });

  it('persists receipts and the signing key across a restart, keeping them verifiable', async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-receipts-'));
    try {
      const first = new MemoryManager({ basePath, embeddingFunction });
      await first.initialize({ localStoragePath: path.join(basePath, 'storage') });
      const bucket = first.createBucket({ name: 'notes', domain: 'personal' });
      const chunk = await first.createChunk('secret', { domain: 'personal', source: 'test', tags: [] });
      bucket.addChunk(chunk);
      first.redactMemories({}, 'cleanup');
      const jwk = first.getSigningPublicJwk()!;
      await first.shutdown();

      const second = new MemoryManager({ basePath, embeddingFunction });
      await second.initialize({ localStoragePath: path.join(basePath, 'storage') });

      const receipts = second.getGovernanceReceipts();
      expect(receipts).toHaveLength(1);
      expect(receipts[0].payload.operation).toBe('redact');
      // Same key survived the restart, so the persisted receipt still verifies...
      expect(second.getSigningPublicJwk()!.kid).toBe(jwk.kid);
      expect(second.verifyGovernanceReceipt(receipts[0])).toBe(true);
      // ...and verifies offline against the previously-exported public JWK too.
      expect(verifyReceiptChain(receipts, jwk)).toBe(-1);

      await second.shutdown();
    } finally {
      await fs.rm(basePath, { recursive: true, force: true });
    }
  });
});
