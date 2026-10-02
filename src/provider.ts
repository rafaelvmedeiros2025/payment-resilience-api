import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { transaction, type Pool } from './db.js';
import type { PaymentInput } from './domain.js';
export function buildProvider(pool: Pool, options: { timeoutDelayMs?: number } = {}) {
 const app = Fastify();
 app.get('/health', async () => ({ status: 'ok', provider: 'simulation' }));
 app.get<{ Params: { key: string } }>('/charges/:key', {
  schema: { params: { type: 'object', required: ['key'], properties: { key: { type:'string',pattern:'^[0-9a-fA-F-]{36}$' } } } }
 }, async (request, reply) => {
  const result = await pool.query('SELECT reference FROM provider_charges WHERE key=$1', [request.params.key]);
  return result.rowCount ? result.rows[0] : reply.code(404).send({ code: 'NOT_FOUND' });
 });
 app.post<{ Body: PaymentInput; Headers: { 'idempotency-key': string } }>('/charges', {
  schema: {
   headers: { type:'object',required:['idempotency-key'],properties:{'idempotency-key':{type:'string',pattern:'^[0-9a-fA-F-]{36}$'}} },
   body: { type:'object',required:['amountCents','currency'],properties:{amountCents:{type:'integer',minimum:1,maximum:2147483647},currency:{type:'string',enum:['USD','BRL','EUR']},mode:{type:'string',enum:['success','temporary','declined','timeout','unavailable']}} }
  }
 }, async (request, reply) => {
  const key = request.headers['idempotency-key'];
  const mode = request.body.mode ?? 'success';
  const outcome = await transaction(pool, async client => {
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [key]);
   const existing = await client.query('SELECT * FROM provider_charges WHERE key=$1', [key]);
   if (existing.rowCount) {
    const row = existing.rows[0];
    if (row.amount_cents !== request.body.amountCents || row.currency !== request.body.currency)
     return { status:409, body:{code:'PROVIDER_KEY_CONFLICT'}, delay:false };
    return { status:200, body:{reference:row.reference}, delay:false };
   }
   const attempt = await client.query(`INSERT INTO provider_attempts(key,attempts) VALUES ($1,1)
    ON CONFLICT(key) DO UPDATE SET attempts=provider_attempts.attempts+1 RETURNING attempts`, [key]);
   if (mode === 'declined') return { status:422, body:{code:'DECLINED'}, delay:false };
   if (mode === 'unavailable' || (mode === 'temporary' && attempt.rows[0].attempts <= 2))
    return { status:503, body:{code:'TEMPORARY_FAILURE'}, delay:false };
   const reference = `sim-${randomUUID()}`;
   await client.query('INSERT INTO provider_charges(key,reference,amount_cents,currency) VALUES ($1,$2,$3,$4)', [key,reference,request.body.amountCents,request.body.currency]);
   return { status:201, body:{reference}, delay:mode === 'timeout' };
  });
  // Persist the charge before delaying the HTTP response: emulate an ambiguous timeout.
  if (outcome.delay) await setTimeout(options.timeoutDelayMs ?? 1200);
  return reply.code(outcome.status).send(outcome.body);
 });
 return app;
}
