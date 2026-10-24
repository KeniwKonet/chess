import { startServer } from './server';

const port = Number(process.env.PORT ?? 8787);
const s = await startServer(port);
console.log(`Chess Realms server on ws://localhost:${s.port}  (try ?room=ashen&mode=ai or ?room=duel&mode=pvp)`);
