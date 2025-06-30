
const puppeteer = require('puppeteer');
const WebSocket = require('ws');

// Usage : node agent.js <roomId> <agentName>
const [roomId, agentName = 'AI'] = process.argv.slice(2);
if (!roomId) {
  console.error('Usage: node agent.js <roomId> [agentName]');
  process.exit(1);
}

(async () => {
  console.log(`[Agent] Launching headless browser…`);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  // 1) Ouvrir votre front-end peerconnection.html

   const url = `http://localhost:8080/peerconnection.html#${roomId}`;
 await page.goto(url, {
   waitUntil: 'domcontentloaded',   // plus rapide à déclencher
   timeout: 0                        // désactive le timeout
 });
  console.log(`[Agent] Page loaded, joined room ${roomId}`);

  // 2) Se connecter au WS pour le chat
  const ws = new WebSocket('ws://localhost:3000');
  ws.on('open', () => {
    console.log('[Agent WS] connected');
    ws.send(JSON.stringify({ join: roomId }));
  });

  ws.on('message', async data => {
    const msg = JSON.parse(data);
    if (msg.type === 'chat' && msg.from !== agentName) {
      console.log(`[Agent WS] ${msg.from} says: "${msg.text}"`);

      // 3) Appeler votre API LoRA pour générer la réponse
      const response = await fetch('http://127.0.0.1:8000/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: msg.text, max_length: 64 })
      });
      const { text } = await response.json();
      console.log(`[Agent WS] replying: ${text}`);

      // 4) Renvoyer le message dans le chat
      ws.send(JSON.stringify({
        type: 'chat',
        room: roomId,
        from: agentName,
        text
      }));
    }
  });

  ws.on('error', err => console.error('[Agent WS] error', err));
})();
