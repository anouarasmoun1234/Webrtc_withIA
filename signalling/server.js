const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const wss = new WebSocket.Server({ port: 3000 });
const rooms = new Map(); // roomId → Map<peerId, socket>

wss.on('connection', socket => {
  let roomId, peerId;

  socket.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // New join
    if (msg.join) {
      roomId = msg.join;
      peerId = uuidv4();
      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      const peers = rooms.get(roomId);

      // 1) Tell the newcomer their assigned peerId
      socket.send(JSON.stringify({ type: 'your-id', peerId }));

      // 2) Send them the list of existing peers
      socket.send(JSON.stringify({
        type:  'peers',
        peers: Array.from(peers.keys())
      }));

      // 3) Add the newcomer
      peers.set(peerId, socket);

      // 4) Notify everyone else of this newcomer
      for (const [otherId, otherSocket] of peers) {
        if (otherId !== peerId && otherSocket.readyState === WebSocket.OPEN) {
          otherSocket.send(JSON.stringify({
            type:   'new-peer',
            peerId
          }));
        }
      }
      return;
    }

    // Relay WebRTC signals
    if (msg.type === 'signal' && msg.to) {
      const peers = rooms.get(roomId);
      const dest  = peers && peers.get(msg.to);
      if (dest && dest.readyState === WebSocket.OPEN) {
        dest.send(JSON.stringify({
          type:   'signal',
          from:   peerId,
          signal: msg.signal
        }));
      }
    }

    // Relay chat messages
    if (msg.type === 'chat' && msg.room && msg.from && msg.text) {
      const peersInRoom = rooms.get(msg.room) || new Map();
      for (const [otherId, otherSocket] of peersInRoom) {
        if (otherSocket !== socket && otherSocket.readyState === WebSocket.OPEN) {
          otherSocket.send(JSON.stringify({
            type: 'chat',
            from: msg.from,
            text: msg.text
          }));
        }
      }
    }

  });

  socket.on('close', () => {
    if (!roomId || !peerId) return;
    const peers = rooms.get(roomId);
    if (!peers) return;
    peers.delete(peerId);
    // notify the remaining peers
    for (const otherSocket of peers.values()) {
      if (otherSocket.readyState === WebSocket.OPEN) {
        otherSocket.send(JSON.stringify({
          type:   'peer-left',
          peerId
        }));
      }
    }
    if (peers.size === 0) rooms.delete(roomId);
  });
});

console.log('Signalling mesh server on ws://localhost:3000');
