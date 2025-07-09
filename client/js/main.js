'use strict';

// UI references
const localVideo = document.getElementById('local');
const videosDiv = document.getElementById('videos');
const hangupBtn = document.getElementById('hangup');

// Chat UI references
const msgsDiv = document.getElementById('msgs');
const txt = document.getElementById('txt');
const btn = document.getElementById('btn');

// Transcription UI
const transcriptDiv = document.createElement('div');
transcriptDiv.id = 'transcript';
transcriptDiv.style.background = '#f0f0f0';
transcriptDiv.style.padding = '10px';
transcriptDiv.style.marginTop = '20px';
transcriptDiv.style.borderRadius = '8px';
transcriptDiv.style.maxHeight = '100px';
transcriptDiv.style.overflowY = 'auto';
document.body.insertBefore(transcriptDiv, videosDiv.nextSibling);

let localStream;
const peers = new Map();    // peerId → RTCPeerConnection
let myPeerId;               // set by signalling



// Audio processing
let audioContext;
let audioProcessor;
let transcriptionSocket;

// 1) Room ID from URL hash
const roomId = location.hash.slice(1) || crypto.randomUUID();
if (!location.hash) location.hash = roomId;

// 2) Capture local media first
async function startLocalStream() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ 
      video: true, 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000,
        channelCount:1// Optimisé pour Whisper
      }
    });
    localVideo.srcObject = localStream;
    console.log('[Init] localStream ready');
    
    // Initialize audio processing for transcription
    initAudioProcessing();
  } catch (e) {
    alert('getUserMedia failed: ' + e.message);
    throw e;
  }
}

// Initialize audio processing for transcription
function initAudioProcessing() {
  try {
    // Create audio context
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 16000 // Fréquence optimale pour Whisper
    });
    
    // Create audio source from local stream
    const audioSource = audioContext.createMediaStreamSource(localStream);
    
    // Create processor node - taille de buffer réduite pour moins de latence
    audioProcessor = audioContext.createScriptProcessor(1024, 1, 1);
    
    // Configure processor
// Remplacer la conversion Int16 par du Float32 direct
audioProcessor.onaudioprocess = (event) => {
  if (!transcriptionSocket || transcriptionSocket.readyState !== WebSocket.OPEN) return;
  
  // Float32 direct (plus efficace)
  const pcmData = event.inputBuffer.getChannelData(0);
  transcriptionSocket.send(pcmData);
};
    
    // Connect nodes
    audioSource.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
    
    console.log('[Audio] Processing initialized');
  } catch (error) {
    console.error('Audio processing error:', error);
  }
}

// 3) Signalling setup (mesh + chat)
let socket;
function startSignalling() {
  socket = new WebSocket('ws://localhost:3000');

  socket.addEventListener('open', () => {
    console.log('[WS] connected, joining room', roomId);
    socket.send(JSON.stringify({ join: roomId }));
    
    // Connect to transcription server
    connectTranscriptionWebSocket();
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

// Connect to transcription WebSocket
function connectTranscriptionWebSocket() {
  transcriptionSocket = new WebSocket('ws://localhost:8000/transcribe');
  
  transcriptionSocket.onopen = () => {
    console.log('[Transcription] WS connected');
    
    // Envoyez la configuration audio - CORRECTION ICI
    const config = {
      sampleRate: audioContext.sampleRate,
      channels: 1,
      language: 'en'
    };
    transcriptionSocket.send(JSON.stringify(config));
  };
  
  transcriptionSocket.onmessage = (event) => {
    try {
      // Utilisez directement le texte (pas de JSON.parse)
      const transcriptText = event.data;
      transcriptDiv.textContent = transcriptText;
    } catch (e) {
      console.error('Error handling transcript:', e);
    }
  };
  
  transcriptionSocket.onerror = (error) => {
    console.error('[Transcription] WS error:', error);
  };
  
  transcriptionSocket.onclose = () => {
    console.log('[Transcription] WS closed');
  };
}

// 4) Create or reuse a PeerConnection
async function createPeerConnection(peerId, isCaller) {
  if (peers.has(peerId) || peerId === myPeerId) return;
  console.log('[Peer] create PC for', peerId, 'caller?', isCaller);

  const pc = new RTCPeerConnection({ 
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
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
  // Fermer la connexion de transcription
  if (transcriptionSocket) {
    transcriptionSocket.close();
    transcriptionSocket = null;
  }
  
  // Arrêter le traitement audio
  if (audioProcessor) {
    audioProcessor.disconnect();
    audioProcessor = null;
  }
  
  // Fermer le contexte audio
  if (audioContext) {
    audioContext.close().catch(console.error);
    audioContext = null;
  }
  
  // Fermer les connexions P2P
  peers.forEach(pc => pc.close());
  peers.clear();
  
  // Supprimer les vidéos distantes
  document.querySelectorAll('[id^="remote-"]').forEach(el => el.remove());
  
  console.log('[Hangup] All connections closed');
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

// Autoriser l'envoi avec Enter
txt.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    btn.click();
  }
});

// 7) Start everything
(async () => {
  await startLocalStream();
  startSignalling();
  console.log('[Init] ready for mesh + chat + transcription');
})();