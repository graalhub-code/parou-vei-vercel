const { Redis } = require('@upstash/redis');

// Aceita tanto o nome de env var usado pela integracao "Upstash" quanto pela
// antiga "Vercel KV" (ambas viram Upstash Redis por baixo dos panos), pra nao
// depender de qual delas o usuario conectou no painel da Vercel.
const url =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.parou_vei_vercel_KV_REST_API_URL;

const token =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.parou_vei_vercel_KV_REST_API_TOKEN;

let redis = null;
function getRedis() {
  if (!url || !token) {
    throw new Error(
      'Redis nao configurado. Conecte a integracao Upstash Redis (ou Vercel KV) ao projeto na Vercel.'
    );
  }
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

const ROOM_PREFIX = 'parouvei:room:';
const ANSWERS_PREFIX = 'parouvei:answers:';
const LOCK_PREFIX = 'parouvei:lock:';

async function getRoom(code) {
  const raw = await getRedis().get(ROOM_PREFIX + code);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function saveRoom(room, ttlSeconds) {
  room.updatedAt = Date.now();
  await getRedis().set(ROOM_PREFIX + room.code, JSON.stringify(room), { ex: ttlSeconds });
}

async function deleteRoom(code) {
  await getRedis().del(ROOM_PREFIX + code, ANSWERS_PREFIX + code);
}

async function setAnswer(code, playerId, category, value) {
  await getRedis().hset(ANSWERS_PREFIX + code, { [`${playerId}::${category}`]: value ?? '' });
}

async function mergeAnswers(code, playerId, answersObj) {
  const entries = Object.entries(answersObj || {});
  if (entries.length === 0) return;
  const fields = {};
  for (const [cat, val] of entries) fields[`${playerId}::${cat}`] = val ?? '';
  await getRedis().hset(ANSWERS_PREFIX + code, fields);
}

async function getAnswers(code) {
  const flat = await getRedis().hgetall(ANSWERS_PREFIX + code);
  const answers = {};
  if (!flat) return answers;
  for (const [key, value] of Object.entries(flat)) {
    const sep = key.indexOf('::');
    const playerId = key.slice(0, sep);
    const cat = key.slice(sep + 2);
    answers[playerId] = answers[playerId] || {};
    answers[playerId][cat] = value;
  }
  return answers;
}

async function clearAnswers(code) {
  await getRedis().del(ANSWERS_PREFIX + code);
}

// Lock simples baseado em SET NX PX, com poucas tentativas curtas. Suficiente
// pra uma sala de ate 10 jogadores - nao precisa de nada mais sofisticado.
async function withRoomLock(code, fn, { retries = 20, delayMs = 100, ttlMs = 4000 } = {}) {
  const lockKey = LOCK_PREFIX + code;
  const token = Math.random().toString(36).slice(2);
  let acquired = false;
  for (let i = 0; i < retries; i++) {
    const res = await getRedis().set(lockKey, token, { nx: true, px: ttlMs });
    if (res === 'OK' || res === true) { acquired = true; break; }
    await new Promise(r => setTimeout(r, delayMs));
  }
  if (!acquired) {
    throw new Error('Sala ocupada, tenta de novo em instantes.');
  }
  try {
    return await fn();
  } finally {
    // best-effort release; se o lock ja expirou nao tem problema
    try {
      const current = await getRedis().get(lockKey);
      if (current === token) await getRedis().del(lockKey);
    } catch { /* noop */ }
  }
}

module.exports = {
  getRedis, getRoom, saveRoom, deleteRoom,
  setAnswer, mergeAnswers, getAnswers, clearAnswers,
  withRoomLock,
};
