import { startServer } from './server';
import { log } from './online/log';

const port = Number(process.env.PORT ?? 8787);
const s = await startServer(port);
// The first line stays plain text: tools and tests wait for it.
console.log(`ChessFront server on http://localhost:${s.port}  (online play: /api and /online; storage: ${s.online?.db.kind})`);
log.info('server started', { port: s.port, db: s.online?.db.kind, admins: (process.env.ADMIN_NAMES ?? '').split(',').filter(Boolean).length });
let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info('server stopping', { signal });
  await s.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
process.on('uncaughtException', (e) => log.error('uncaught exception', e));
