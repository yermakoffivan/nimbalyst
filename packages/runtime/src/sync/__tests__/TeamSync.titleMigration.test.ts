/**
 * Doc-index TITLE read path across the legacy-e2e -> server-managed migration
 * (NIM-906).
 *
 * Mirrors DocumentSync.serverManagedMigration.test.ts but for the TeamRoom
 * doc-index titles. When a team migrates, title rows written before the flip
 * stay AES-ciphertext on the server (the TeamRoom passes them through with
 * their original non-empty iv; only DEK-fingerprinted rows are server-decrypted
 * to plaintext with an empty-iv sentinel). The client must:
 *   - pass through rows with an empty iv (server plaintext),
 *   - AES-decrypt rows with a non-empty iv using the retained legacy org key,
 *   - surface a row it cannot decrypt as `decryptFailed` (locked), never as raw
 *     base64, and never blanking the rest of the list,
 *   - and a client that DOES hold the legacy key can re-register the recovered
 *     titles as plaintext (backfill) so the server re-keys them under the DEK.
 */

import { describe, expect, it, vi } from 'vitest';
import { TeamSyncProvider } from '../TeamSync';
import type { TeamSyncConfig } from '../teamSyncTypes';

async function createAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

/** Encrypt a title the way the legacy wire did: AES-256-GCM, base64 ct + iv. */
async function wireEncryptTitle(title: string, key: CryptoKey): Promise<{ encryptedTitle: string; titleIv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(title) as BufferSource);
  return {
    encryptedTitle: Buffer.from(new Uint8Array(ct)).toString('base64'),
    titleIv: Buffer.from(iv).toString('base64'),
  };
}

function serverManagedProvider(legacyOrgKey?: CryptoKey): TeamSyncProvider {
  const config: TeamSyncConfig = {
    serverUrl: 'ws://example.test',
    getJwt: async () => 'token',
    orgId: 'org-1',
    userId: 'user-1',
    keyCustody: 'server-managed',
    orgKeyFingerprint: null,
    legacyOrgKey,
  };
  return new TeamSyncProvider(config);
}

function encEntry(documentId: string, encryptedTitle: string, titleIv: string) {
  return {
    documentId,
    encryptedTitle,
    titleIv,
    documentType: 'markdown',
    createdBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('TeamSync doc-index title server-managed migration read path', () => {
  it('passes through plaintext titles with the empty-iv sentinel', async () => {
    const provider = serverManagedProvider();
    const entry = await (provider as any).decryptEntry(encEntry('doc-1', 'My Plain Title', ''));
    expect(entry.title).toBe('My Plain Title');
    expect(entry.decryptFailed).toBeFalsy();
    provider.destroy();
  });

  it('AES-decrypts legacy ciphertext titles (non-empty iv) with the legacy org key', async () => {
    const legacyKey = await createAesKey();
    const provider = serverManagedProvider(legacyKey);
    const { encryptedTitle, titleIv } = await wireEncryptTitle('Folder/Real Doc', legacyKey);
    expect(titleIv).not.toBe('');
    const entry = await (provider as any).decryptEntry(encEntry('doc-2', encryptedTitle, titleIv));
    expect(entry.title).toBe('Folder/Real Doc');
    expect(entry.decryptFailed).toBeFalsy();
    provider.destroy();
  });

  it('throws (so the caller marks it locked) on a legacy title when no legacy key is available', async () => {
    const provider = serverManagedProvider(/* no legacy key */);
    const legacyKey = await createAesKey();
    const { encryptedTitle, titleIv } = await wireEncryptTitle('secret', legacyKey);
    await expect((provider as any).decryptEntry(encEntry('doc-3', encryptedTitle, titleIv))).rejects.toThrow();
    provider.destroy();
  });

  it('marks an undecryptable legacy title as decryptFailed without raw base64 or blanking siblings', async () => {
    const legacyKey = await createAesKey();
    const otherKey = await createAesKey();
    const provider = serverManagedProvider(/* no legacy key -> legacy row unreadable */);

    const legacy = await wireEncryptTitle('unreadable', otherKey);
    const docs = await (provider as any).decryptDocuments([
      encEntry('plain-1', 'Visible Plain', ''),
      encEntry('legacy-1', legacy.encryptedTitle, legacy.titleIv),
    ]);

    const plain = docs.find((d: any) => d.documentId === 'plain-1');
    const locked = docs.find((d: any) => d.documentId === 'legacy-1');
    expect(plain.title).toBe('Visible Plain');
    expect(plain.decryptFailed).toBeFalsy();
    expect(locked.decryptFailed).toBe(true);
    // Never the raw ciphertext as a title.
    expect(locked.title).not.toBe(legacy.encryptedTitle);
    expect(legacyKey).toBeDefined();
    provider.destroy();
  });

  it('self-heals recovered legacy titles on load, re-registering them as PLAINTEXT (empty iv)', async () => {
    const legacyKey = await createAesKey();
    const provider = serverManagedProvider(legacyKey);
    const sent: any[] = [];
    (provider as any).send = (msg: any) => { sent.push(msg); };

    const legacy = await wireEncryptTitle('Notes/Recovered', legacyKey);
    // Load a mixed index: one already-plaintext, one legacy ciphertext. The
    // load path's one-shot auto self-heal fires for the legacy row.
    await (provider as any).handleDocIndexSyncResponse({
      type: 'docIndexSyncResponse',
      documents: [
        encEntry('plain-1', 'Already Plain', ''),
        encEntry('legacy-1', legacy.encryptedTitle, legacy.titleIv),
      ],
    });
    // Let the fire-and-forget auto self-heal settle.
    await new Promise((r) => setTimeout(r, 0));

    const updates = sent.filter((m) => m.type === 'docIndexUpdate');
    expect(updates).toHaveLength(1);
    expect(updates[0].documentId).toBe('legacy-1');
    expect(updates[0].encryptedTitle).toBe('Notes/Recovered'); // plaintext
    expect(updates[0].titleIv).toBe(''); // empty-iv sentinel => server DEK-encrypts at rest

    // Idempotent: an explicit re-run is now a no-op (work already claimed).
    expect(await provider.backfillLegacyTitles()).toBe(0);
    expect(sent.filter((m) => m.type === 'docIndexUpdate')).toHaveLength(1);
    provider.destroy();
  });
});
