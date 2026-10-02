import { randomUUID } from 'node:crypto';
import { transaction, type Pool } from './db.js';
import { retryDelay, type Outcome } from './domain.js';
import type { PaymentProvider, ProviderPayment } from './provider-client.js';
export interface Claim extends ProviderPayment { attempts: number; lease_token: string }
export async function claimNext(pool: Pool, leaseMs = 10000): Promise<Claim | undefined> {
 return transaction(pool, async client => {
  const result = await client.query(`SELECT * FROM payments
   WHERE NOT needs_review AND status IN ('queued','unknown','processing')
   AND available_at <= now() AND (leased_until IS NULL OR leased_until <= now())
   ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`);
  if (!result.rowCount) return undefined;
  const row = result.rows[0];
  const token = randomUUID();
  await client.query(`UPDATE payments SET status='processing',attempts=attempts+1,lease_token=$2,
   leased_until=now()+($3::double precision * interval '1 millisecond'),updated_at=now() WHERE id=$1`, [row.id,token,leaseMs]);
  await client.query("INSERT INTO payment_events(payment_id,event_type,details) VALUES ($1,'payment.claimed',$2)", [row.id,JSON.stringify({ attempt: row.attempts + 1 })]);
  return { ...row, attempts: row.attempts + 1, lease_token: token } as Claim;
 });
}
export async function finishClaim(pool: Pool, claim: Claim, outcome: Outcome, maxAttempts = 5) {
 return transaction(pool, async client => {
  const needsReview = outcome.status === 'unknown' && claim.attempts >= maxAttempts;
  // Fence stale workers: only the current lease owner may commit a result.
  const result = await client.query(`UPDATE payments SET status=$3,provider_reference=$4,last_error=$5,
   needs_review=$6,lease_token=NULL,leased_until=NULL,updated_at=now(),
   available_at=now()+($7::double precision * interval '1 millisecond')
   WHERE id=$1 AND lease_token=$2 RETURNING id`,
   [claim.id,claim.lease_token,outcome.status,outcome.status === 'succeeded' ? outcome.reference : null,
    outcome.status === 'succeeded' ? null : outcome.error,needsReview,retryDelay(claim.attempts)]);
  if (!result.rowCount) return false;
  await client.query('INSERT INTO payment_events(payment_id,event_type,details) VALUES ($1,$2,$3)',
   [claim.id, needsReview ? 'payment.review_required' : `payment.${outcome.status}`, JSON.stringify({ attempt: claim.attempts, needsReview })]);
  return true;
 });
}
export async function processNext(pool: Pool, provider: PaymentProvider, options: { leaseMs?: number; maxAttempts?: number } = {}) {
 const claim = await claimNext(pool, options.leaseMs);
 if (!claim) return false;
 let outcome: Outcome;
 try { outcome = await provider.execute(claim); }
 catch (error) { outcome = { status: 'unknown', error: error instanceof Error ? error.message : 'Unexpected provider error' }; }
 await finishClaim(pool, claim, outcome, options.maxAttempts);
 return true;
}
