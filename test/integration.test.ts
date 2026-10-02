import { describe,test,before,beforeEach,after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { buildProvider } from '../src/provider.js';
import { HttpPaymentProvider } from '../src/provider-client.js';
import { claimNext,finishClaim,processNext } from '../src/worker.js';
import type { PaymentInput } from '../src/domain.js';
if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL is required; use a disposable database');
const pool=createPool(process.env.TEST_DATABASE_URL);
const app=buildApp(pool);const simulator=buildProvider(pool,{timeoutDelayMs:1000});
let provider:HttpPaymentProvider;
const body:PaymentInput={amountCents:2500,currency:'USD'};
const post=(key:string,payload:PaymentInput=body)=>app.inject({method:'POST',url:'/payments',headers:{'idempotency-key':key},payload});
async function due(){await pool.query("UPDATE payments SET available_at=now() WHERE status IN ('queued','unknown')");}
async function read(id:string){return (await app.inject({url:`/payments/${id}`})).json();}
describe('durable payment processing with a real HTTP simulator and PostgreSQL',{concurrency:false},()=>{
 before(async()=>{await pool.query(await readFile('migrations/001_initial.sql','utf8'));await app.ready();const url=await simulator.listen({port:0,host:'127.0.0.1'});provider=new HttpPaymentProvider(url,250);});
 beforeEach(async()=>{await pool.query('TRUNCATE payment_events,request_keys,payments,provider_attempts,provider_charges RESTART IDENTITY CASCADE');});
 after(async()=>{await app.close();await simulator.close();await pool.end();});
 test('accepts payment asynchronously and exposes its current state',async()=>{
  const response=await post('new');assert.equal(response.statusCode,202);assert.equal(response.json().status,'queued');
  await processNext(pool,provider);assert.equal((await read(response.json().id)).status,'succeeded');
  assert.equal((await pool.query('SELECT * FROM provider_charges')).rowCount,1);
 });
 test('concurrent duplicate submissions create exactly one payment',async()=>{
  const results=await Promise.all(Array.from({length:8},()=>post('same')));
  assert.equal(results.filter(r=>r.statusCode===202).length,1);assert.equal(results.filter(r=>r.statusCode===200).length,7);
  assert.equal(new Set(results.map(r=>r.json().id)).size,1);assert.equal((await pool.query('SELECT * FROM payments')).rowCount,1);
 });
 test('changed amount with the same key returns a conflict',async()=>{
  await post('conflict');assert.equal((await post('conflict',{...body,amountCents:5000})).statusCode,409);
 });
 test('parallel workers cannot claim the same active lease',async()=>{
  await post('workers');const outcomes=await Promise.all(Array.from({length:5},()=>processNext(pool,provider)));
  assert.equal(outcomes.filter(Boolean).length,1);assert.equal((await pool.query('SELECT * FROM provider_charges')).rowCount,1);
 });
 test('expired lease can be reclaimed and fences the stale worker result',async()=>{
  const payment=(await post('lease')).json();const old=await claimNext(pool);assert.ok(old);
  await pool.query("UPDATE payments SET leased_until=now()-interval '1 second' WHERE id=$1",[payment.id]);
  const current=await claimNext(pool);assert.ok(current);assert.notEqual(current.lease_token,old.lease_token);
  assert.equal(await finishClaim(pool,old,{status:'succeeded',reference:'stale-reference'}),false);
  assert.equal(await finishClaim(pool,current,{status:'succeeded',reference:'current-reference'}),true);
  assert.equal((await read(payment.id)).provider_reference,'current-reference');
 });
 test('temporary failures recover with a single eventual charge',async()=>{
  const payment=(await post('retry',{...body,mode:'temporary'})).json();
  await processNext(pool,provider);assert.equal((await read(payment.id)).status,'unknown');assert.equal(await processNext(pool,provider),false);
  await due();await processNext(pool,provider);await due();await processNext(pool,provider);
  assert.equal((await read(payment.id)).status,'succeeded');assert.equal((await read(payment.id)).attempts,3);
  assert.equal((await pool.query('SELECT * FROM provider_charges')).rowCount,1);
 });
 test('timeout after provider commit is reconciled without duplicate charge',async()=>{
  const payment=(await post('timeout',{...body,mode:'timeout'})).json();await processNext(pool,provider);
  assert.equal((await read(payment.id)).status,'unknown');assert.equal((await pool.query('SELECT * FROM provider_charges')).rowCount,1);
  await due();await processNext(pool,provider);assert.equal((await read(payment.id)).status,'succeeded');
  assert.equal((await pool.query('SELECT attempts FROM provider_attempts')).rows[0].attempts,1);
 });
 test('permanent decline is terminal and never retried',async()=>{
  const payment=(await post('decline',{...body,mode:'declined'})).json();await processNext(pool,provider);
  assert.equal((await read(payment.id)).status,'declined');assert.equal(await processNext(pool,provider),false);
  assert.equal((await pool.query('SELECT * FROM provider_charges')).rowCount,0);
 });
 test('exhausted uncertain outcomes require review rather than reporting failure',async()=>{
  const payment=(await post('review',{...body,mode:'unavailable'})).json();
  await processNext(pool,provider,{maxAttempts:2});await due();await processNext(pool,provider,{maxAttempts:2});
  const result=await read(payment.id);assert.equal(result.status,'unknown');assert.equal(result.needs_review,true);
  assert.equal(await processNext(pool,provider),false);
 });
 test('worker crash after external charge is recovered by provider lookup',async()=>{
  const payment=(await post('crash')).json();const abandoned=await claimNext(pool);assert.ok(abandoned);
  assert.equal((await provider.execute(abandoned)).status,'succeeded');
  await pool.query("UPDATE payments SET leased_until=now()-interval '1 second' WHERE id=$1",[payment.id]);
  await processNext(pool,provider);assert.equal((await read(payment.id)).status,'succeeded');
  assert.equal((await pool.query('SELECT * FROM provider_charges')).rowCount,1);
  assert.equal((await pool.query('SELECT attempts FROM provider_attempts')).rows[0].attempts,1);
 });
 test('provider rejects reuse of a key with a different amount',async()=>{
  const payment=(await post('provider-conflict')).json();await processNext(pool,provider);
  const response=await simulator.inject({method:'POST',url:'/charges',headers:{'idempotency-key':payment.id},payload:{...body,amountCents:9999}});
  assert.equal(response.statusCode,409);assert.equal((await pool.query('SELECT * FROM provider_charges')).rowCount,1);
 });
 test('validation prevents invalid amounts and missing idempotency keys',async()=>{
  assert.equal((await post('bad',{...body,amountCents:-1})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/payments',payload:body})).statusCode,400);
  assert.equal((await app.inject({url:'/payments/not-a-uuid'})).statusCode,400);
  assert.equal((await app.inject({url:'/health/ready'})).statusCode,200);
  assert.equal((await pool.query('SELECT * FROM payments')).rowCount,0);
 });
});
