import { createApp } from './app.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);
// Local development only: WORKBOARD_DEV_NO_AUTH=1 skips pairing, and is refused unless bound to loopback.
const authDisabled = process.env.WORKBOARD_DEV_NO_AUTH === '1' && ['127.0.0.1', 'localhost', '::1'].includes(host);
const { server, scheduler, orgSync, pocket } = createApp({ root: process.cwd(), authDisabled });
server.listen(port, host, () => {
  scheduler.start();
  orgSync.start();
  pocket.start();
  console.log(`Workboard is running at http://${host}:${port} (notifier ${scheduler.status().configured ? 'configured' : 'NOT configured'})`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { scheduler.stop(); orgSync.stop(); pocket.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
