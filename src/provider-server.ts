import { createPool } from './db.js';
import { buildProvider } from './provider.js';
const pool = createPool();
const app = buildProvider(pool);
let stopping=false;
async function shutdown() { if(stopping)return;stopping=true;await app.close();await pool.end(); }
for(const signal of ['SIGTERM','SIGINT']) process.once(signal, () => { shutdown().catch(error => {console.error(error);process.exitCode=1;}); });
try { await app.listen({port:Number(process.env.PROVIDER_PORT ?? 4000),host:'0.0.0.0'}); }
catch(error) { console.error(error);await shutdown();process.exitCode=1; }
