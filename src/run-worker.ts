import { setTimeout } from 'node:timers/promises';
import { createPool } from './db.js';
import { HttpPaymentProvider } from './provider-client.js';
import { processNext } from './worker.js';
const pool=createPool();
const providerUrl=process.env.PROVIDER_URL;
if(!providerUrl) throw new Error('PROVIDER_URL is required');
const timeoutMs=Number(process.env.PROVIDER_TIMEOUT_MS ?? 300);
const pollMs=Number(process.env.WORKER_POLL_MS ?? 250);
const leaseMs=Number(process.env.WORKER_LEASE_MS ?? 10000);
if(!Number.isFinite(timeoutMs)||timeoutMs<1||!Number.isFinite(pollMs)||pollMs<10||!Number.isFinite(leaseMs)||leaseMs<=timeoutMs*2)
 throw new Error('Invalid worker timing configuration; lease must exceed two HTTP timeouts');
const provider=new HttpPaymentProvider(providerUrl,timeoutMs);
let stopping=false;
for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{stopping=true;});
try {
 while(!stopping) {
  try {
   const processed=await processNext(pool,provider,{leaseMs});
   if(processed) console.log(JSON.stringify({event:'payment.processed',time:new Date().toISOString()}));
   else await setTimeout(pollMs);
  } catch(error) { console.error(JSON.stringify({event:'worker.error',message:error instanceof Error?error.message:'Unknown error'}));await setTimeout(pollMs); }
 }
} finally { await pool.end(); }
