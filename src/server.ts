import { createPool } from './db.js';
import { buildApp } from './app.js';
const pool = createPool();
const app = buildApp(pool, true);
let stopping = false;
async function shutdown() { if(stopping) return; stopping=true; await app.close(); await pool.end(); }
for(const signal of ['SIGTERM','SIGINT']) process.once(signal, () => { shutdown().catch(error => { console.error(error); process.exitCode=1; }); });
try { await app.listen({port:Number(process.env.PORT ?? 3000),host:process.env.HOST ?? '0.0.0.0'}); }
catch(error) { app.log.error(error); await shutdown(); process.exitCode=1; }
