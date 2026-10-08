import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PRIVACY_KEY_PATH = path.resolve(process.cwd(), 'data', 'privacy.key');
const PRIVACY_SALT = process.env.PRIVACY_SALT || 'agentlayer-default-salt-change-me';
const STORE_ENCRYPTED_PAYLOADS = process.env.STORE_ENCRYPTED_PAYLOADS === 'true';

let cachedKey = null;

function getPrivacyKey() {
  if (cachedKey) return cachedKey;
  fs.mkdirSync(path.dirname(PRIVACY_KEY_PATH), { recursive: true });
  try {
    // Exclusive creation cannot overwrite an existing deployment's key.
    fs.writeFileSync(PRIVACY_KEY_PATH, crypto.randomBytes(32).toString('base64'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const fd = fs.openSync(PRIVACY_KEY_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let raw;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('invalid_privacy_key_file');
    const permissions = stat.mode & 0o777;
    // A 0400 secret mounted read-only is already owner-only. Do not attempt to
    // chmod it: read-only secret mounts commonly reject metadata writes.
    if (permissions !== 0o400 && permissions !== 0o600) fs.fchmodSync(fd, 0o600);
    raw = fs.readFileSync(fd, 'utf8').trim();
  } finally {
    fs.closeSync(fd);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('invalid_privacy_key_length');
  cachedKey = key;
  return key;
}

export function hashIdentifier(value) {
  return `usr_${crypto.createHash('sha256').update(`${PRIVACY_SALT}:${String(value)}`).digest('hex').slice(0, 24)}`;
}

export function hashPrompt(prompt) {
  return `ph_${crypto.createHash('sha256').update(String(prompt)).digest('hex')}`;
}

export function sealPayload(payload) {
  if (!STORE_ENCRYPTED_PAYLOADS) return null;
  const key = getPrivacyKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

const REDACTED_KEYS = new Set(['prompt', 'email', 'name', 'ip', 'address', 'phone', 'user', 'userId']);

export function sanitizeMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (REDACTED_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}
