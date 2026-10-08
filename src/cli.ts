import { getDb } from './db.ts';
import { seedPrices } from './pricing.ts';
import { startServer, buildRouter } from './server.ts';
import { startSignalWorker } from './signals.ts';
import { startEvalWorker } from './evals/index.ts';

const PORT = Number(process.env.BLACKBOX_PORT || 7777);
const OTLP_PORT = Number(process.env.BLACKBOX_OTLP_PORT || 4318);

async function serve() {
  const db = getDb();
  seedPrices(db);
  const router = buildRouter();
  startSignalWorker(db);
  startEvalWorker();
  await startServer(PORT, router);
  try {
    await startServer(OTLP_PORT, router, { ui: false });
  } catch (e: any) {
    console.log(`[blackbox] port ${OTLP_PORT} busy, OTLP only on ${PORT}`);
  }
  console.log(`[blackbox] ui + api + otlp  http://localhost:${PORT}`);
  console.log(`[blackbox] otlp             http://localhost:${OTLP_PORT}/v1/{traces,logs,metrics}`);
}

async function demo() {
  const db = getDb();
  seedPrices(db);
  const { seedDemo } = await import('./demo.ts');
  const n = Number(process.argv[3] || 320);
  const r = seedDemo({ traces: n });
  console.log(`[blackbox] seeded ${r.traces} demo traces (${r.spans} spans) into project "demo"`);
}

const cmd = process.argv[2] ?? 'serve';
if (cmd === 'serve') await serve();
else if (cmd === 'demo') await demo();
else {
  console.error(`unknown command ${cmd}`);
  process.exit(1);
}
