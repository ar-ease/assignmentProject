import { app } from './app.js';
import { prisma } from './db.js';
import { expirePendingOrders } from './orders.js';

const port = Number(process.env.PORT ?? 4000);
const server = app.listen(port, '0.0.0.0', () => console.log(`Pickup Counter API listening on ${port}`));
const sweeper = setInterval(() => {
  expirePendingOrders().catch((error: unknown) => console.error('Order expiry sweep failed', error));
}, 5000);

function shutdown() {
  clearInterval(sweeper);
  server.close(() => { void prisma.$disconnect(); });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
