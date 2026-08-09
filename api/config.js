// A key e o cluster do Pusher nao sao segredos (sao usados pelo cliente pra
// assinar canais publicos) - so o app secret, esse sim, fica so no servidor
// (lib/pusher.js). Esse endpoint existe pra nao precisar hardcodar a key no
// HTML estatico.
module.exports = (req, res) => {
  const key = process.env.PUSHER_KEY || process.env.PUSHER_APP_KEY || '';
  const cluster = process.env.PUSHER_CLUSTER || process.env.PUSHER_APP_CLUSTER || '';
  if (!key || !cluster) {
    res.status(500).json({ error: 'Pusher nao configurado no servidor.' });
    return;
  }
  res.status(200).json({ key, cluster });
};
