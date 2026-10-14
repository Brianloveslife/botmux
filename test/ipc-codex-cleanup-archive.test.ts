import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as pool from '../src/core/worker-pool.js';
import * as store from '../src/services/session-store.js';
import * as globalConfig from '../src/global-config.js';
import { setCodexAppThreadArchived } from '../src/services/codex-app-threads.js';
import type { Session } from '../src/types.js';
vi.mock('../src/core/daemon-ipc-session-auth.js', async original => ({
  ...await original<typeof import('../src/core/daemon-ipc-session-auth.js')>(),
  authorizeSessionScopedIpc: vi.fn(() => ({ ok: true })),
}));
vi.mock('../src/services/codex-app-threads.js', async original => ({
  ...await original<typeof import('../src/services/codex-app-threads.js')>(),
  setCodexAppThreadArchived: vi.fn(async () => undefined),
}));
let handle: IpcServerHandle | undefined;
afterEach(async () => { await handle?.close(); handle = undefined; vi.restoreAllMocks(); vi.mocked(setCodexAppThreadArchived).mockReset(); });

async function close(idleCleanup: boolean, enabled: boolean, patch: Partial<Session> = {}, fail = false) {
  const row = { sessionId: 'mock-cleanup', status: 'active', cliId: 'codex', backendType: 'pty', larkAppId: 'mock-bot',
    cliSessionId: 'mock-native', codexCleanupTarget: { threadId: 'mock-native', codexHome: '/tmp/mock-codex', codexBin: '/tmp/mock-codex-bin' },
    ...patch } as Session;
  vi.spyOn(pool, 'findActiveBySessionId').mockReturnValue({ session: row, larkAppId: row.larkAppId } as any);
  vi.spyOn(store, 'getSession').mockReturnValue(row);
  vi.spyOn(store, 'getOwnedSession').mockReturnValue(row);
  vi.spyOn(store, 'updateSession').mockImplementation(() => {});
  vi.spyOn(globalConfig, 'readGlobalConfig').mockReturnValue({ sessionCleanup: { archiveCodex: enabled } });
  vi.spyOn(pool, 'closeSession').mockImplementation(async () => { row.status = 'closed'; return { ok: true, alreadyClosed: false, outcome: 'closed' } as any; });
  if (fail) vi.mocked(setCodexAppThreadArchived).mockRejectedValueOnce(new Error('mock archive error'));
  else vi.mocked(setCodexAppThreadArchived).mockResolvedValue(undefined);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/mock-cleanup/close`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idleCleanup }),
  });
  return { row, response, body: await response.json() };
}
describe('daemon close idle-cleanup intent', () => {
  it('archives only after closing when both intent and setting are on', async () => {
    const result = await close(true, true);
    expect(result.body.ok).toBe(true);
    expect(setCodexAppThreadArchived).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'mock-native', archived: true }));
    expect(result.row.codexCleanupArchive?.state).toBe('archived');
  });
  it.each([[false, true], [true, false]])('ordinary close / setting off does not archive (%s/%s)', async (intent, enabled) => {
    expect((await close(intent, enabled)).body.ok).toBe(true);
    expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
  });
  it('supports owned codex-app threads with the same cleanup intent', async () => {
    expect((await close(true, true, { cliId: 'codex-app' })).body.ok).toBe(true);
    expect(setCodexAppThreadArchived).toHaveBeenCalledWith(expect.objectContaining({ archived: true, codexBin: '/tmp/mock-codex-bin' }));
  });
  it('reports the observed legacy codex-app case without issuing any native write', async () => {
    const result = await close(true, true, { cliId: 'codex-app', backendType: undefined, codexCleanupTarget: undefined });
    expect(result.body).toMatchObject({ ok: true, archiveError: 'codex_archive_target_unverified' });
    expect(result.row.codexCleanupArchive).toBeUndefined();
    expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
  });
  it('archives a legacy codex-app row after its worker has proved the target', async () => {
    expect((await close(true, true, { cliId: 'codex-app', backendType: undefined })).body.ok).toBe(true);
    expect(setCodexAppThreadArchived).toHaveBeenCalledOnce();
  });
  it('skips adopted external sessions', async () => {
    expect((await close(true, true, { adoptedFrom: { cwd: '/tmp' } })).body.ok).toBe(true);
    expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
  });
  it('keeps successful local close and reports a recoverable archive failure', async () => {
    const result = await close(true, true, {}, true);
    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, archiveError: 'mock archive error' });
    expect(result.row.status).toBe('closed');
    expect(result.row.codexCleanupArchive?.state).toBe('pending');
  });
});
