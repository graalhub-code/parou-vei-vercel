const Pusher = require('pusher');

let pusher = null;
function getPusher() {
  const appId = process.env.PUSHER_APP_ID;
  const key = process.env.PUSHER_KEY || process.env.PUSHER_APP_KEY;
  const secret = process.env.PUSHER_SECRET || process.env.PUSHER_APP_SECRET;
  const cluster = process.env.PUSHER_CLUSTER || process.env.PUSHER_APP_CLUSTER;
  if (!appId || !key || !secret || !cluster) {
    throw new Error(
      'Pusher nao configurado. Conecte a integracao Pusher Channels ao projeto na Vercel.'
    );
  }
  if (!pusher) {
    pusher = new Pusher({ appId, key, secret, cluster, useTLS: true });
  }
  return pusher;
}

function channelFor(code) {
  return `room-${code}`;
}

// Pusher limita o payload de cada trigger; disparamos em serie sem
// paralelismo excessivo pra nao estourar rate limit do plano free.
async function broadcastEvents(code, events) {
  const p = getPusher();
  const channel = channelFor(code);
  for (const event of events) {
    if (!event) continue;
    const { type, ...payload } = event;
    await p.trigger(channel, type, payload);
  }
}

module.exports = { getPusher, channelFor, broadcastEvents };
