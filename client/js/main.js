'use strict';

// UI references
const localVideo  = document.getElementById('local');

const videosDiv   = document.getElementById('videos');
const hangupBtn   = document.getElementById('hangup');

// Chat UI references
const msgsDiv = document.getElementById('msgs');
const txt     = document.getElementById('txt');
const btn     = document.getElementById('btn');
// audio recording :
const startRecBtn   = document.getElementById('start-rec');
const stopRecBtn    = document.getElementById('stop-rec');
const transcriptDiv = document.getElementById('transcript');




const remoteRecorders = new Map();
const transcriptDivs  = new Map();

let mediaRecorder, audioChunks = [];
// Web Audio pour mixer les flux distants// ajouter 
const audioCtx    = new AudioContext();
const mixDest     = audioCtx.createMediaStreamDestination();
// MediaRecorder qui va « streamer » les chunks du mix
let remoteRecorder;


let localStream;
const peers    = new Map();    // peerId → RTCPeerConnection
let myPeerId;                  // set by signalling

// 1) Room ID from URL hash
const roomId = location.hash.slice(1) || crypto.randomUUID();
if (!location.hash) location.hash = roomId;

// 2) Capture local media first
async function startLocalStream() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    console.log('[Init] localStream ready');
  } catch (e) {
    alert('getUserMedia failed: ' + e.message);
    throw e;
  }
}

// 3) Signalling setup (mesh + chat)
let socket;
function startSignalling() {
  socket = new WebSocket('ws://localhost:3000');

  socket.addEventListener('open', () => {
    console.log('[WS] connected, joining room', roomId);
    socket.send(JSON.stringify({ join: roomId }));
  });

  socket.addEventListener('message', async ({ data }) => {
    const msg = JSON.parse(data);

    switch (msg.type) {
      // --- MESH EVENTS ---
      case 'your-id':
        myPeerId = msg.peerId;
        console.log('[WS] myPeerId =', myPeerId);
        break;

      case 'peers':
        console.log('[WS] peers:', msg.peers);
        msg.peers.forEach(id => {
          if (id !== myPeerId) createPeerConnection(id, true);
        });
        break;

      case 'new-peer':
        console.log('[WS] new peer:', msg.peerId);
        if (msg.peerId === myPeerId) return;
        createPeerConnection(msg.peerId, false);
        break;

      case 'signal': {
        const { from, signal } = msg;
        if (from === myPeerId) return;
        const pc = peers.get(from);
        if (!pc) return;

        if (signal.sdp) {
          console.log(`[Signal] ${signal.type} from`, from);
          await pc.setRemoteDescription(signal);
          if (signal.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.send(JSON.stringify({
              type:   'signal',
              to:     from,
              signal: pc.localDescription
            }));
          }
        } else {
          console.log('[Signal] ICE candidate from', from);
          await pc.addIceCandidate(signal);
        }
        break;
      }

      case 'peer-left':
        console.log('[WS] peer left:', msg.peerId);
        const pc = peers.get(msg.peerId);
        if (pc) pc.close();
        peers.delete(msg.peerId);
        const el = document.getElementById(`remote-${msg.peerId}`);
        if (el) el.remove();
        break;

      // --- CHAT EVENTS ---
      case 'chat':
        const line = document.createElement('div');
        line.textContent = `${msg.from}: ${msg.text}`;
        msgsDiv.appendChild(line);
        msgsDiv.scrollTop = msgsDiv.scrollHeight;
        break;
    }
  });
}

// 4) Create or reuse a PeerConnection
async function createPeerConnection(peerId, isCaller) {
  if (peers.has(peerId) || peerId === myPeerId) return;
  console.log('[Peer] create PC for', peerId, 'caller?', isCaller);

  const pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.l.google.com:19302'}] });
  peers.set(peerId, pc);

  // Add local tracks
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // ICE → signalling
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.send(JSON.stringify({
        type:   'signal',
        to:     peerId,
        signal: candidate
      }));
    }
  };

  // Create & mute remote video
  const remoteVid = document.createElement('video');
  remoteVid.id          = `remote-${peerId}`;
  remoteVid.autoplay    = true;
  remoteVid.playsinline = true;
  remoteVid.muted       = false;
  
  videosDiv.appendChild(remoteVid);

  // Attach remote stream
pc.ontrack = ({ streams }) => {
  console.log('[Peer] ontrack from', peerId);
  remoteVid.srcObject = streams[0];

  // branchement WebAudio
  const srcNode = audioCtx.createMediaStreamSource(streams[0]);
  srcNode.connect(mixDest);

  // si ce n’est pas déjà fait, on démarre le recorder ici
  if (!remoteRecorder) {
    console.log('[Recorder] first remote track, starting recorder');
    startRemoteRecorder();
  }
};
  // Only newcomers send the initial offer
  if (isCaller) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.send(JSON.stringify({
      type:   'signal',
      to:     peerId,
      signal: pc.localDescription
    }));
  }
}

// 5) Hangup cleanup
hangupBtn.addEventListener('click', () => {
  peers.forEach(pc => pc.close());
  peers.clear();
  document.querySelectorAll('[id^="remote-"]').forEach(el => el.remove());
});

// 6) Chat send handler
btn.addEventListener('click', () => {
  const t = txt.value.trim();
  if (!t) return;
  const me = document.createElement('div');
  me.textContent = `Me: ${t}`;
  msgsDiv.appendChild(me);
  msgsDiv.scrollTop = msgsDiv.scrollHeight;
  socket.send(JSON.stringify({
    type: 'chat',
    room: roomId,
    from: myPeerId || 'Me',
    text: t
  }));
  txt.value = '';
});
// === Partie enregistrement audio pour IA ===
async function initRecorder() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    console.log('[Recorder] onstop, chunks count:', audioChunks.length);
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    audioChunks = [];

    const form = new FormData();
    form.append('audio', blob, 'speech.webm');

    console.log('[Recorder] Sending to /transcribe…');
    try {
      const res = await fetch('http://localhost:8000/transcribe', {
        method: 'POST',
        body: form
      });
      console.log('[Recorder] Response status:', res.status);
      const json = await res.json();
      console.log('[Recorder] Response JSON:', json);
      transcriptDiv.textContent = json.text;
    } catch (err) {
      console.error('[Recorder] Fetch error:', err);
      transcriptDiv.textContent = 'Error: ' + err.message;
    }
  };
  // lance la capture du mix dès qu’un peer se connecte
function startRemoteRecorder() {
  if (remoteRecorder) return;
  console.log('[Recorder] init on mix stream →', mixDest.stream);
  remoteRecorder = new MediaRecorder(mixDest.stream);
  remoteRecorder.ondataavailable = async e => {
      console.log('[Recorder] chunk disponible, taille:', e.data.size);
    if (!e.data || e.data.size === 0) return;
    const form = new FormData();
    form.append('audio', e.data, 'remote-chunk.webm');
    const res  = await fetch('http://localhost:8000/transcribe', {
      method: 'POST', body: form
    });
    const { text } = await res.json();
    // affiche et / ou renvoie dans le chat mesh
    const line = document.createElement('div');
    line.style.fontStyle = 'italic';
    line.textContent = `🗣️ Transcription peers: ${text}`;
    msgsDiv.appendChild(line);
    msgsDiv.scrollTop = msgsDiv.scrollHeight;

    socket.send(JSON.stringify({
      type: 'chat', room: roomId, from: 'transcript', text
    }));
  };
  remoteRecorder.onerror = ev => console.error('[Recorder] error', ev);
  remoteRecorder.onstart = () => console.log('[Recorder] started');
  // on découpe tous les 2 s
  remoteRecorder.start(2000);
}

// dès que l’on rejoint le room, on lance la capture distante
startRemoteRecorder();

}

startRecBtn.addEventListener('click', async () => {
  if (!mediaRecorder) await initRecorder();
  console.log('[Recorder] start');
  mediaRecorder.start(2000);
  startRecBtn.disabled = true;
  stopRecBtn.disabled  = false;
  transcriptDiv.textContent = '…recording…';
});

stopRecBtn.addEventListener('click', () => {
  console.log('[Recorder] stop');
  mediaRecorder.stop();
  startRecBtn.disabled = false;
  stopRecBtn.disabled  = true;

});
// ============================================

// 7) Start everything
(async () => {
  await startLocalStream();
  startSignalling();
     // ajouter 
  console.log('[Init] ready for mesh + chat');
})();

// pour le code je spéciefier chaque pour la facilité de modification



