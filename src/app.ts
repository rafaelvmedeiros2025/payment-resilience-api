import Fastify, { type FastifyError } from 'fastify';
import type { Pool } from './db.js';
import { DomainError, type PaymentInput } from './domain.js';
import { createPayment, readPayment } from './payments.js';
export function buildApp(pool: Pool, logger = false) {
 const app = Fastify({ logger, bodyLimit: 8192 });
 app.setErrorHandler((error, request, reply) => {
  if (error instanceof DomainError) return reply.code(error.statusCode).send({ code:error.code,message:error.message });
  const failure = error as FastifyError;
  if (failure.validation) return reply.code(400).send({ code:'VALIDATION_ERROR',message:'Invalid request' });
  if (failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500)
   return reply.code(failure.statusCode).send({ code:'REQUEST_ERROR',message:failure.message });
  request.log.error({err:error},'Request failed');
  return reply.code(500).send({code:'INTERNAL_ERROR',message:'Internal server error'});
 });
 app.get('/health/live', async () => ({status:'ok'}));
 app.get('/health/ready', async (_request, reply) => {
  try { await pool.query('SELECT 1'); return {status:'ready'}; }
  catch { return reply.code(503).send({status:'unavailable'}); }
 });
 app.post<{ Body:PaymentInput; Headers:{'idempotency-key':string} }>('/payments', {
  schema: {
   headers:{type:'object',required:['idempotency-key'],properties:{'idempotency-key':{type:'string',minLength:1,maxLength:128}}},
   body:{type:'object',additionalProperties:false,required:['amountCents','currency'],properties:{
    amountCents:{type:'integer',minimum:1,maximum:2147483647},currency:{type:'string',enum:['USD','BRL','EUR']},
    mode:{type:'string',enum:['success','temporary','declined','timeout','unavailable']}
   }}
  }
 }, async (request,reply) => {
  const result = await createPayment(pool, request.headers['idempotency-key'], request.body);
  return reply.code(result.replayed ? 200 : 202).header('location',`/payments/${result.id}`).send(await readPayment(pool,result.id));
 });
 app.get<{Params:{id:string}}>('/payments/:id', {
  schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'}}}}
 }, request => readPayment(pool,request.params.id));
 return app;
}
