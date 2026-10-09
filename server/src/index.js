import http from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { syncReferenceData, ensureOwner } from './bootstrap.js';
import { attachSocket } from './socket.js';
import { startJobs } from './jobs.js';
import { logger } from './lib/logger.js';

async function main() {
  await migrate();
  await syncReferenceData();
  await ensureOwner();
  const app = createApp();
  const server = http.createServer(app);
  attachSocket(server);
  startJobs();
  server.listen(config.port, () => logger.info('server.started', { port: config.port, env: config.env }));
  const shutdown = () => { logger.info('server.stopping'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { logger.error('server.fatal', { message: e.message, stack: e.stack }); process.exit(1); });
