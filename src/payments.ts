import { randomUUID } from 'node:crypto';
import { transaction, type Pool } from './db.js';
import { DomainError, fingerprint, type PaymentInput } from './domain.js';
export async function createPayment(pool: Pool, key: string, input: PaymentInput) {
 return transaction(pool, async client => {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  const hash = fingerprint(input);
  const existing = await client.query('SELECT * FROM request_keys WHERE key=$1', [key]);
  if (existing.rowCount) {
   if (existing.rows[0].request_hash !== hash) throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'Key used with different payment details');
   return { id: existing.rows[0].payment_id as string, replayed: true };
  }
  const id = randomUUID();
  await client.query('INSERT INTO payments(id,amount_cents,currency,mode) VALUES ($1,$2,$3,$4)', [id,input.amountCents,input.currency,input.mode ?? 'success']);
  await client.query('INSERT INTO request_keys VALUES ($1,$2,$3)', [key,hash,id]);
  await client.query("INSERT INTO payment_events(payment_id,event_type) VALUES ($1,'payment.accepted')", [id]);
  return { id, replayed: false };
 });
}
export async function readPayment(pool: Pool, id: string) {
 const result = await pool.query(`SELECT id,amount_cents,currency,mode,status,attempts,provider_reference,last_error,needs_review,created_at,updated_at FROM payments WHERE id=$1`, [id]);
 if (!result.rowCount) throw new DomainError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
 return result.rows[0];
}
