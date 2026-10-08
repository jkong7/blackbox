import { getDb } from './db.ts';
import { seedPrices } from './pricing.ts';
import { startServer, buildRouter } from './server.ts';

const PORT = Number(process.env.BLACKBOX_PORT || 7777);
const OTLP_PORT = Number(process.env.BLACKBOX_OTLP_PORT || 4318);

async function serve() {
  const db = getDb();
  seedPrices(db);
  const router = buildRouter();
  await startServer(PORT, router);
  try {
    await startServer(OTLP_PORT, router, { ui: false });
  } catch (e: any) {
    console.log(`[blackbox] port ${OTLP_PORT} busy, OTLP only on ${PORT}`);
  }
  console.log(`[blackbox] ui + api + otlp  http://localhost:${PORT}`);
  console.log(`[blackbox] otlp             http://localhost:${OTLP_PORT}/v1/{traces,logs,metrics}`);
}

const cmd = process.argv[2] ?? 'serve';
if (cmd === 'serve') await serve();
else {
  console.error(`unknown command ${cmd}`);
  process.exit(1);
}
