import { startServer } from './server';

const port = Number(process.env.PORT ?? 8787);
const s = await startServer(port);
console.log(`ChessFront server on http://localhost:${s.port}  (online play: /api and /online; storage: ${s.online?.db.kind})`);
const stop = async () => {
  await s.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
