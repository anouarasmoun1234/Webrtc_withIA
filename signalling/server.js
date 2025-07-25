

'use strict';

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const FASTAPI_URL   = 'http://localhost:8000';      

const wss   = new WebSocket.Server({ port: 3000 });
const rooms = new Map();                            


//  Helpers                                         */

function broadcastChat(roomId, from, text) {
  const peers = rooms.get(roomId) || new Map();
  for (const [, ws] of peers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat', from, text }));
    }
  }
}

function broadcastAudio(roomId, b64) {
  if (!b64) return;
  const peers = rooms.get(roomId) || new Map();
  for (const [, ws] of peers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'lara-audio', b64 }));
    }
  }
}
/* ------------------------------------------------ */

wss.on('connection', socket => {
  let roomId, peerId;

  socket.on('message', async data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    /* -------- JOIN -------- */
    if (msg.join) {
      roomId = msg.join;
      peerId = uuidv4();

      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      const peers = rooms.get(roomId);

      socket.send(JSON.stringify({ type: 'your-id', peerId }));
      socket.send(JSON.stringify({ type: 'peers', peers: Array.from(peers.keys()) }));
      peers.set(peerId, socket);

      for (const [otherId, otherSocket] of peers) {
        if (otherId !== peerId && otherSocket.readyState === WebSocket.OPEN) {
          otherSocket.send(JSON.stringify({ type: 'new-peer', peerId }));
        }
      }
      return;
    }

    /* -------- WebRTC SIGNAL -------- */
    if (msg.type === 'signal' && msg.to) {
      const dest = rooms.get(roomId)?.get(msg.to);
      if (dest?.readyState === WebSocket.OPEN) {
        dest.send(JSON.stringify({ type: 'signal', from: peerId, signal: msg.signal }));
      }
      return;
    }

    /* -------- CHAT / COMMANDES LARA -------- */
    if (msg.type === 'chat' && msg.room && msg.from && typeof msg.text === 'string') {
      const trimmed = msg.text.trim().toLowerCase();

      /* ----- Résumé ----- */
      const summaryMatch = trimmed.match(/^@lara summary(?:\s+(\d+)(?:\s*(?:min|mins?|minutes)?)?)?$/)
                         || trimmed.match(/^@lara résumé(?:\s+(\d+)(?:\s*(?:min|mins?|minutes)?)?)?$/);

      if (summaryMatch) {
        const minutes = Math.min(parseInt(summaryMatch[1] || '5', 10), 60);   // défaut 5, max 60
        try {
          const resp = await fetch(`${FASTAPI_URL}/summary?window=${minutes}`);
          const data = await resp.json();

          broadcastChat(msg.room, 'Lara-Résumé', data.text || '(résumé indisponible)');
          broadcastAudio(msg.room, data.wav_b64 || '');
        } catch (err) {
          console.error('[SIG] /summary error:', err);
        }
        return;                               // ne relaie pas le message original
      }

      /* ----- Question @lara … ----- */
      if (trimmed.startsWith('@lara')) {
        const question = msg.text.replace(/^@lara\s*/i, '');
        try {
          const resp = await fetch(`${FASTAPI_URL}/ask_speech`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ question, window: 5 })
          });
          const data = await resp.json();

          broadcastChat(msg.room, 'Lara', data.text || '(Lara) [no text]');
          broadcastAudio(msg.room, data.wav_b64 || '');
        } catch (err) {
          console.error('[SIG] /ask_speech error:', err);
        }
        return;                               
      }

      /* ----- Chat normal ----- */
      broadcastChat(msg.room, msg.from, msg.text);
      return;
    }

    /* -------- TRANSCRIPTION RELAY -------- */
    if (msg.type === 'transcription' && msg.room && msg.text) {
      const peers = rooms.get(msg.room) || new Map();
      for (const [otherId, ws] of peers) {
        if (otherId !== peerId && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type:       'transcription',
            text:       msg.text,
            from:       peerId,
            timestamp:  Date.now()
          }));
        }
      }
    }
  });

  /* -------- DISCONNECT -------- */
  socket.on('close', () => {
    if (!roomId || !peerId) return;
    const peers = rooms.get(roomId);
    if (!peers) return;

    peers.delete(peerId);
    for (const ws of peers.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'peer-left', peerId }));
      }
    }
    if (peers.size === 0) rooms.delete(roomId);
  });
});

console.log('Signalling mesh server on ws://localhost:3000');
