// 同步后端：私有 GitHub 仓库当"带版本号的加密文件柜"。
// Contents API 的 sha 天然充当 baseRev（条件写入），commit 历史天然是快照历史。
import type { EncryptedSnapshot } from './crypto'

export type SyncConfig = {
  token: string   // GitHub PAT，只放 localStorage，仅用于读写那一个文件
  repo: string     // owner/repo
  path: string    // 快照文件路径
}

const API = 'https://api.github.com'

function headers(cfg: SyncConfig): HeadersInit {
  return { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
}

export type RemoteSnapshot = { sha: string; snapshot: EncryptedSnapshot }

async function readRemote(cfg: SyncConfig): Promise<RemoteSnapshot | null> {
  const r = await fetch(`${API}/repos/${cfg.repo}/contents/${cfg.path}`, { headers: headers(cfg) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`读取远端失败（HTTP ${r.status}）`)
  const j = await r.json()
  return { sha: j.sha, snapshot: JSON.parse(atob(j.content.replace(/\n/g, ''))) as EncryptedSnapshot }
}

export async function pullRemote(cfg: SyncConfig): Promise<RemoteSnapshot | null> {
  return readRemote(cfg)
}

export type PushResult =
  | { ok: true; sha: string }
  | { conflict: true; remote: RemoteSnapshot }

export async function pushRemote(cfg: SyncConfig, baseSha: string | null, snapshot: EncryptedSnapshot): Promise<PushResult> {
  const body: Record<string, string> = {
    message: 'sync: do less snapshot',
    content: btoa(JSON.stringify(snapshot)),
  }
  if (baseSha) body.sha = baseSha
  const r = await fetch(`${API}/repos/${cfg.repo}/contents/${cfg.path}`, {
    method: 'PUT',
    headers: { ...headers(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (r.ok) {
    const j = await r.json()
    return { ok: true, sha: j.content.sha }
  }
  if (r.status === 409 || r.status === 422) {
    // baseRev 不匹配：远端被别人（另一台设备）改过
    const remote = await readRemote(cfg).catch(() => null)
    if (remote) return { conflict: true, remote }
  }
  throw new Error(`写入远端失败（HTTP ${r.status}）`)
}
