import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { setTimeout } from 'node:timers/promises';
import { fingerprint, retryDelay } from '../src/domain.js';
import { HttpPaymentProvider } from '../src/provider-client.js';
const payment = {id:'9fa2b95d-a52b-4840-aa8a-14670a6cbf47',amount_cents:1200,currency:'USD',mode:'success' as const};
test('fingerprints normalize defaults but detect amount and currency changes',()=>{
 const input={amountCents:1200,currency:'USD' as const};
 assert.equal(fingerprint(input),fingerprint({...input,mode:'success'}));
 assert.notEqual(fingerprint(input),fingerprint({...input,amountCents:1201}));
 assert.notEqual(fingerprint(input),fingerprint({...input,currency:'EUR'}));
});
test('exponential retry delay is bounded and supports jitter',()=>{
 assert.equal(retryDelay(1,()=>0),250);assert.equal(retryDelay(3,()=>0.5),1050);assert.equal(retryDelay(20,()=>0),30000);
});
test('lookup failure prevents sending a potentially duplicate charge',async()=>{
 const app=Fastify();let posts=0;
 app.get('/charges/:id',async(_req,reply)=>reply.code(503).send({code:'OFFLINE'}));
 app.post('/charges',async()=>{posts++;return {reference:'unexpected'};});
 const url=await app.listen({port:0,host:'127.0.0.1'});
 try{assert.equal((await new HttpPaymentProvider(url,1000).execute(payment)).status,'unknown');assert.equal(posts,0);}finally{await app.close();}
});
test('existing receipt reconciles without issuing a new POST',async()=>{
 const app=Fastify();let posts=0;
 app.get('/charges/:id',async()=>({reference:'already-charged'}));
 app.post('/charges',async()=>{posts++;return {reference:'duplicate'};});
 const url=await app.listen({port:0,host:'127.0.0.1'});
 try{assert.deepEqual(await new HttpPaymentProvider(url,1000).execute(payment),{status:'succeeded',reference:'already-charged'});assert.equal(posts,0);}finally{await app.close();}
});
test('provider decline is distinguished from an uncertain transport result',async()=>{
 const app=Fastify();app.get('/charges/:id',async(_req,reply)=>reply.code(404).send({}));
 app.post('/charges',async(_req,reply)=>reply.code(422).send({code:'DECLINED'}));
 const url=await app.listen({port:0,host:'127.0.0.1'});
 try{assert.equal((await new HttpPaymentProvider(url,1000).execute(payment)).status,'declined');}finally{await app.close();}
});
test('timed-out HTTP response is reconciled without charging twice',async()=>{
 const app=Fastify();let charged=false;let posts=0;
 app.get('/charges/:id',async(_req,reply)=>charged?{reference:'charged-before-timeout'}:reply.code(404).send({}));
 app.post('/charges',async()=>{charged=true;posts++;await setTimeout(700);return {reference:'charged-before-timeout'};});
 const url=await app.listen({port:0,host:'127.0.0.1'});const provider=new HttpPaymentProvider(url,250);
 try{assert.equal((await provider.execute(payment)).status,'unknown');assert.equal((await provider.execute(payment)).status,'succeeded');assert.equal(posts,1);}finally{await app.close();}
});
test('malformed success responses remain unknown',async()=>{
 const app=Fastify();app.get('/charges/:id',async()=>({reference:42}));
 const url=await app.listen({port:0,host:'127.0.0.1'});
 try{assert.equal((await new HttpPaymentProvider(url,1000).execute(payment)).status,'unknown');}finally{await app.close();}
});
