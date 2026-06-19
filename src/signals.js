import { insertSignal, getByIdemKey, listSignals } from './db.js';
import { checkAndConsume } from './rateLimit.js';

function nowMs(){ return Date.now(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SQLITE_BUSY = db was busy / our simulated outage, safe to retry.
// A constraint error (e.g. duplicate idempotency key) is not - retrying won't help.
function isBusy(e) {
  return e && e.code === 'SQLITE_BUSY';
}
function isDuplicate(e) {
  return e && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT');
}

// Retry a db call a few times on transient errors, backing off with jitter so
// retries don't all fire at the same moment.
async function withRetry(fn, attempts = 6) {
  let delay = 10;
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (!isBusy(e) || i >= attempts) throw e;
      await sleep(delay + Math.random() * delay);
      delay *= 2;
    }
  }
}

export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};
  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
  if (!ok) return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });

  try {
    // already stored this key? return that row instead of inserting again
    if (idem) {
      const existing = await withRetry(() => getByIdemKey(idem));
      if (existing) return existing;
    }

    const t = nowMs();
    const info = await withRetry(() => insertSignal(userId, type, payload, idem, t));
    return { id: info.lastInsertRowid, userId, type, payload: String(payload), idempotencyKey: idem, createdAt: t };
  } catch (e) {
    // Two requests with the same key can both reach the insert; the UNIQUE index
    // lets one win, so the loser reads the key back and returns the stored row.
    if (idem && isDuplicate(e)) {
      const existing = await withRetry(() => getByIdemKey(idem));
      if (existing) return existing;
    }
    req.log.error({ err: e, ctx: 'postSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });
  const lim = Math.min(Number(limit) || 20, 100);
  try {
    const rows = await withRetry(() => listSignals(userId, lim));
    return { items: rows };
  } catch (e) {
    req.log.error({ err: e, ctx: 'listSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}
