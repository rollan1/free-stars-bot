import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.js';
import { db } from './db.js';

/**
 * Telegram собирает data_check_string из полученных полей. Разные клиенты
 * кодируют значения чуть по-разному (пробел как %20 или +, кавычки сырыми
 * или закодированными). HMAC должен совпасть хотя бы с одним вариантом —
 * подпись от этого не ослабевает, вариантов подбора без знания токена нет.
 */
function buildCandidates(initData) {
  const rawPairs = String(initData).split('&').filter(Boolean);
  const split = (pair) => {
    const i = pair.indexOf('=');
    return i < 0 ? [pair, ''] : [pair.slice(0, i), pair.slice(i + 1)];
  };
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const without = (pred) => rawPairs.filter((p) => !pred(split(p)[0]));

  const variants = [
    {
      name: 'decoded_no_hash_no_signature',
      pairs: without((k) => k === 'hash' || k === 'signature').map((p) => [split(p)[0], decode(split(p)[1])]),
    },
    {
      name: 'decoded_no_hash',
      pairs: without((k) => k === 'hash').map((p) => [split(p)[0], decode(split(p)[1])]),
    },
    {
      name: 'raw_no_hash_no_signature',
      pairs: without((k) => k === 'hash' || k === 'signature').map((p) => [split(p)[0], split(p)[1]]),
    },
    {
      name: 'raw_no_hash',
      pairs: without((k) => k === 'hash').map((p) => [split(p)[0], split(p)[1]]),
    },
    {
      name: 'plus_as_space_no_hash_no_signature',
      pairs: without((k) => k === 'hash' || k === 'signature').map((p) => {
        const [k, v] = split(p);
        return [k, decode(v.replace(/\+/g, '%20'))];
      }),
    },
  ];

  const urlParams = parseInitData(initData);
  variants.push({
    name: 'urlsearchparams_no_hash_no_signature',
    pairs: Object.keys(urlParams)
      .filter((k) => k !== 'hash' && k !== 'signature')
      .map((k) => [k, String(urlParams[k])]),
  });

  return variants.map((v) => {
    const sorted = [...v.pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { name: v.name, dcs: sorted.map(([k, value]) => `${k}=${value}`).join('\n') };
  });
}

/**
 * Диагностика: пробуем разные способы сборки строки проверки, чтобы понять,
 * как именно клиент её кодировал. Ничего не логирует, кроме названия варианта.
 */
function probeDecodings(initData, hash) {
  const secret = webAppDataSecret(config.botToken);
  const results = {};
  for (const candidate of buildCandidates(initData)) {
    try {
      const h = crypto.createHmac('sha256', secret).update(candidate.dcs).digest('hex');
      results[candidate.name] = timingSafeEqualHex(h, hash) ? 'MATCH' : 'no';
    } catch (err) {
      results[candidate.name] = `err:${err.message}`;
    }
  }
  return results;
}

/**
 * Диагностика отказа авторизации: ключи, длины и значения без секретов,
 * чтобы сразу понять, что именно не сошлось.
 */
function logAuthFailure({ reason, initData, params, expected, hash, probe }) {
  try {
    const keys = Object.keys(params ?? {});
    const info = {
      reason,
      rawLength: typeof initData === 'string' ? initData.length : 0,
      keys,
      hasSignature: Boolean(params?.signature),
      authAgeSec: params?.auth_date ? Math.floor(Date.now() / 1000) - Number(params.auth_date) : null,
      userFieldLength: params?.user ? String(params.user).length : 0,
    };
    if (probe) {
      const match = Object.entries(probe).filter(([, v]) => v === 'MATCH').map(([k]) => k);
      info.probeMatch = match;
      info.probe = probe;
    }
    if (process.env.CAPTURE_INITDATA_PATH && typeof initData === 'string') {
      try {
        // Временная отладка: сохраняем сырые данные для разбора, без сервера.
        fs.writeFileSync(process.env.CAPTURE_INITDATA_PATH, initData, 'utf8');
      } catch {
        /* не критично */
      }
    }
    console.warn('[auth]', JSON.stringify(info));
  } catch {
    /* диагностика не должна ломать запрос */
  }
}

export class AuthError extends Error {
  constructor(message, code = 'unauthorized') {
    super(message);
    this.code = code;
    this.status = 401;
  }
}

let cachedSecret = null;
let cachedSecretToken = null;

function webAppDataSecret(botToken) {
  if (cachedSecretToken !== botToken) {
    cachedSecret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    cachedSecretToken = botToken;
  }
  return cachedSecret;
}

export function parseInitData(initData) {
  const params = new URLSearchParams(initData || '');
  const out = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Validates Telegram Mini App initData the way Telegram documents it:
 * HMAC-SHA256 over the sorted parameter list with a key derived from the bot token.
 * If a third-party Ed25519 public key is configured, the signature is verified too.
 */
export function validateInitData(initData, { maxAgeSeconds = config.initDataMaxAgeSeconds, now = Date.now() } = {}) {
  if (!config.botToken) throw new AuthError('BOT_TOKEN is not configured on the server', 'server_misconfigured');
  if (typeof initData !== 'string' || !initData.trim()) {
    logAuthFailure({ reason: 'empty_init_data', initData, params: {} });
    throw new AuthError('initData is missing', 'missing_init_data');
  }

const params = parseInitData(initData);
  const hash = params.hash;
  if (!hash) {
    logAuthFailure({ reason: 'no_hash', initData, params });
    throw new AuthError('initData has no hash', 'bad_signature');
  }

  // Проверка подписи: HMAC должен совпасть хотя бы с одним вариантом разбора.
  let matchedVariant = null;
  let matchedDcs = '';
  const secretKey = webAppDataSecret(config.botToken);
  for (const candidate of buildCandidates(initData)) {
    const computed = crypto.createHmac('sha256', secretKey).update(candidate.dcs).digest('hex');
    if (timingSafeEqualHex(computed, hash)) {
      matchedVariant = candidate.name;
      matchedDcs = candidate.dcs;
      break;
    }
  }
  if (!matchedVariant) {
    const probe = probeDecodings(initData, hash);
    logAuthFailure({ reason: 'hash_mismatch', initData, params, probe });
    throw new AuthError('initData signature mismatch', 'bad_signature');
  }
  if (process.env.AUTH_DEBUG) console.log('[auth] подпись сошлась, вариант:', matchedVariant);

  let signatureStatus = 'absent';
  if (params.signature) {
    // Telegram присылает Ed25519-подпись для сторонней проверки.
    // HMAC-проверка выше уже подтверждает подлинность, поэтому отсутствие
    // публичного ключа — не повод отклонять валидные initData.
    const publicKey = process.env.TELEGRAM_PUBLIC_KEY;
    if (!publicKey) {
      signatureStatus = 'skipped';
    } else {
      const ok = crypto.verify(
        null,
        Buffer.from(matchedDcs, 'utf8'),
        crypto.createPublicKey(publicKey),
        Buffer.from(params.signature, 'base64'),
      );
      if (!ok) throw new AuthError('initData third-party signature mismatch', 'bad_signature');
      signatureStatus = 'verified';
    }
  }

  const authDate = Number(params.auth_date);
  if (!Number.isFinite(authDate)) throw new AuthError('initData has no valid auth_date', 'bad_init_data');
  if (maxAgeSeconds > 0 && now / 1000 - authDate > maxAgeSeconds) {
    throw new AuthError('initData is too old', 'expired_init_data');
  }

  let user = null;
  if (params.user) {
    try {
      user = JSON.parse(params.user);
    } catch {
      throw new AuthError('initData has a malformed user field', 'bad_init_data');
    }
  }
  if (!user || !Number.isInteger(user.id)) throw new AuthError('initData has no user id', 'bad_init_data');

  return {
    user: {
      id: user.id,
      username: typeof user.username === 'string' ? user.username : null,
      firstName: typeof user.first_name === 'string' ? user.first_name : null,
      lastName: typeof user.last_name === 'string' ? user.last_name : null,
      languageCode: typeof user.language_code === 'string' ? user.language_code : null,
      isPremium: user.is_premium === true,
    },
    authDate,
    signatureStatus,
    startParam: params.start_param ?? null,
    raw: initData,
  };
}

/** Test helper: builds a valid initData string for an arbitrary user. */
export function buildInitDataForTest(user, botToken = config.botToken, authDate = Math.floor(Date.now() / 1000)) {
  const params = {
    user: JSON.stringify(user),
    auth_date: String(authDate),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
  };
  const dataCheckString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('\n');
  const hash = crypto.createHmac('sha256', webAppDataSecret(botToken)).update(dataCheckString).digest('hex');
  const encoded = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  return `${encoded}&hash=${hash}`;
}

export function upsertUser(tgUser) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (tg_id, username, first_name, last_name, language_code, is_premium, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tg_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       language_code = excluded.language_code,
       is_premium = excluded.is_premium,
       last_seen_at = excluded.last_seen_at`,
  ).run(
    tgUser.id,
    tgUser.username ?? null,
    tgUser.firstName ?? null,
    tgUser.lastName ?? null,
    tgUser.languageCode ?? null,
    tgUser.isPremium ? 1 : 0,
    now,
    now,
  );
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgUser.id);
}

export function isOwner(tgId) {
  return Number.isInteger(tgId) && config.ownerIds.includes(tgId);
}