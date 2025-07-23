
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const FASTAPI_URL = 'http://localhost:8000';                                         // NEW

const wss   = new WebSocket.Server({ port: 3000 });
const rooms = new Map(); // roomId -> Map<peerId, socket>



wss.on('connection', socket => {
  let roomId, peerId;

  socket.on('message', async data => {      // async pour fetch
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // New join
    if (msg.join) {
      roomId = msg.join;
      peerId = uuidv4();
      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      const peers = rooms.get(roomId);

      socket.send(JSON.stringify({ type: 'your-id', peerId }));
      socket.send(JSON.stringify({
        type:  'peers',
        peers: Array.from(peers.keys())
      }));

      peers.set(peerId, socket);

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
      return;
    }

    // Relay chat  (with @lara interception)
    if (msg.type === 'chat' && msg.room && msg.from && typeof msg.text === 'string') {

      const trimmed = msg.text.trim();
      if (trimmed.toLowerCase().startsWith('@lara')) {
        // --- CALL LARA ---
        const question = trimmed.slice(5).trim();   // remove "@lara"
        console.log('[SIG] @lara question:', question);

        try {
          const resp = await fetch(`${FASTAPI_URL}/ask_speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, window: 5 })
          });
          const data = await resp.json();
          const answerText = data.text || '(Lara) [no text]';
          const wav_b64    = data.wav_b64 || '';

          // 1) Diffuser réponse texte à tous
          const peersInRoom = rooms.get(msg.room) || new Map();
          for (const [otherId, otherSocket] of peersInRoom) {
            if (otherSocket.readyState === WebSocket.OPEN) {
              otherSocket.send(JSON.stringify({
                type: 'chat',
                from: 'Lara',
                text: answerText
              }));
            }
          }

          // 2) Diffuser audio b64 (temporaire; navigateur va juste logger)
          if (wav_b64) {
            for (const [otherId, otherSocket] of peersInRoom) {
              if (otherSocket.readyState === WebSocket.OPEN) {
                otherSocket.send(JSON.stringify({
                  type: 'lara-audio',
                  b64: wav_b64
                }));
              }
            }
          }
        } catch (err) {
          console.error('[SIG] Error calling /ask_speech:', err);
        }
        return; // ne relaye PAS le @lara original
      }

      // Chat normal
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
      return;
    }

    // Relay transcription
    if (msg.type === 'transcription' && msg.room && msg.text) {
      const peersInRoom = rooms.get(msg.room) || new Map();
      for (const [otherId, otherSocket] of peersInRoom) {
        if (otherId !== peerId && otherSocket.readyState === WebSocket.OPEN) {
          otherSocket.send(JSON.stringify({
            type: 'transcription',
            text: msg.text,
            from: peerId,
            timestamp: Date.now()
          }));
        }
      }
      return;
    }
  });

  socket.on('close', () => {
    if (!roomId || !peerId) return;
    const peers = rooms.get(roomId);
    if (!peers) return;
    peers.delete(peerId);
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
 