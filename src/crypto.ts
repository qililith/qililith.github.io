// 快照加密：密码只进内存，PBKDF2 派生 AES-GCM 密钥，密文才会被存储/传输。
const te = new TextEncoder()
const td = new TextDecoder()

export type EncryptedSnapshot = {
  v: 1
  salt: string // base64，PBKDF2 盐
  iv: string   // base64，AES-GCM 初始向量
  data: string // base64，密文
}

type Bytes = Uint8Array<ArrayBuffer>

function toB64(bytes: Bytes): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(b64: string): Bytes {
  const s = atob(b64)
  const out = new Uint8Array(s.length) as Bytes
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function deriveKey(password: string, salt: Bytes): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptJson(obj: unknown, password: string): Promise<EncryptedSnapshot> {
  const salt = crypto.getRandomValues(new Uint8Array(16)) as Bytes
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Bytes
  const key = await deriveKey(password, salt)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)))
  return { v: 1, salt: toB64(salt), iv: toB64(iv), data: toB64(new Uint8Array(ct)) }
}

export async function decryptJson<T>(snap: EncryptedSnapshot, password: string): Promise<T> {
  const key = await deriveKey(password, fromB64(snap.salt))
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(snap.iv) }, key, fromB64(snap.data))
  return JSON.parse(td.decode(pt)) as T
}
