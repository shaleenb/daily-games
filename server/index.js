import { createApp } from './app.js';

const port = Number(process.env.PORT || 4321);
const host = '127.0.0.1';

const app = createApp();

app.server.listen(port, host, () => {
  console.log(`Daily Games Hub running at http://${host}:${port}`);
});

async function shutdown() {
  await app.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
