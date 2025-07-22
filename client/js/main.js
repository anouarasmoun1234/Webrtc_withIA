
'use strict';

// =====================
// UI references

const localVideo = document.getElementById('local');
const videosDiv  = document.getElementById('videos');
const hangupBtn  = document.getElementById('hangup');

// Chat UI references
const msgsDiv = document.getElementById('msgs');
const txt     = document.getElementById('txt');
const btn     = document.getElementById('btn');

// Transcription UI
const transcriptDiv = document.createElement('div');
transcriptDiv.id = 'transcript';
transcriptDiv.style.background   = '#f0f0f0';
transcriptDiv.style.padding      = '10px';
transcriptDiv.style.marginTop    = '20px';
transcriptDiv.style.borderRadius = '8px';
transcriptDiv.style.maxHeight    = '100px';
transcriptDiv.style.overflowY    = 'auto';
document.body.insertBefore(transcriptDiv, videosDiv.nextSibling);

// =====================
// State
// =====================
let localStream;
const peers = new Map(); // peerId -> RTCPeerConnection
let myPeerId;

// Audio processing
let audioContext;
let audioProcessor;
let transcriptionSocket;

//lara 
import { initLaraAudio } from '~/STAGE-folder/WebRTC/ai/lara.js'; // Adjust path as needed
let lara; 
// 1) Room ID from URL hash
const roomId = location.hash.slice(1) || crypto.randomUUID();
if (!location.hash) location.hash = roomId;

// =====================
// Local media capture
// =====================
async function startLocalStream() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000,
        channelCount: 1 // Optimisé pour Whisper
      }
    });
    localVideo.srcObject = localStream;
    console.log('[Init] localStream ready');
    initAudioProcessing();
  } catch (e) {
    alert('getUserMedia failed: ' + e.message);
    throw e;
  }
}

// =====================
// Audio processing -> WS transcription
// =====================
function initAudioProcessing() {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 16000
    });
    lara = initLaraAudio(audioContext);

    const audioSource = audioContext.createMediaStreamSource(localStream);

    // ScriptProcessor est déprécié mais ok pour prototypage
    audioProcessor = audioContext.createScriptProcessor(1024, 1, 1);

    audioProcessor.onaudioprocess = (event) => {
      if (!transcriptionSocket || transcriptionSocket.readyState !== WebSocket.OPEN) return;
      const pcmData = event.inputBuffer.getChannelData(0);  // Float32Array
      // IMPORTANT: envoyer un ArrayBuffer, pas l'objet JS
      transcriptionSocket.send(pcmData.buffer.slice(0));
    };

    audioSource.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination); // (ou audioContext.createGain() silencieux)

    console.log('[Audio] Processing initialized');
  } catch (error) {
    console.error('Audio processing error:', error);
  }
}

// =====================
// Signalling (mesh + chat)
// =====================
let socket;
function startSignalling() {
  socket = new WebSocket('ws://localhost:3000');

  socket.addEventListener('open', () => {
    console.log('[WS] connected, joining room', roomId);
    socket.send(JSON.stringify({ join: roomId }));
    //
  });

  socket.addEventListener('message', async ({ data }) => {
    const msg = JSON.parse(data);

    switch (msg.type) {

      // --- MESH EVENTS ---
      case 'your-id': {
        myPeerId = msg.peerId;
        console.log('[WS] myPeerId =', myPeerId);

        // ouvrir le WS de transcription une fois qu'on connaît mon ID
        connectTranscriptionWebSocket();
        break;
      }

      case 'peers': {
        console.log('[WS] peers:', msg.peers);
        msg.peers.forEach(id => {
          if (id !== myPeerId) createPeerConnection(id, true);
        });
        break;
      }

      case 'new-peer': {
        console.log('[WS] new peer:', msg.peerId);
        if (msg.peerId === myPeerId) break;
        createPeerConnection(msg.peerId, false);
        break;
      }

      case 'signal': {
        const { from, signal } = msg;
        if (from === myPeerId) break;
        const pc = peers.get(from);
        if (!pc) break;

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

      case 'peer-left': {
        console.log('[WS] peer left:', msg.peerId);
        const pc = peers.get(msg.peerId);
        if (pc) pc.close();
        peers.delete(msg.peerId);
        const el = document.getElementById(`remote-${msg.peerId}`);
        if (el) el.remove();
        break;
      }

      // --- CHAT EVENTS ---
      case 'chat': {
        const line = document.createElement('div');
        line.textContent = `${msg.from}: ${msg.text}`;
        msgsDiv.appendChild(line);
        msgsDiv.scrollTop = msgsDiv.scrollHeight;
        break;
      }

      // --- TRANSCRIPTION (diffusée par signalling) ---
      case 'transcription': {
        // afficher la transcription d’un autre pair
        const line = document.createElement('div');
        line.textContent = `${msg.from || 'Remote'} (STT): ${msg.text}`;
        transcriptDiv.appendChild(line);
        transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
        break;
      }
            // --- LARA AUDIO (temp debug) ---
      case 'lara-audio': {
        if (lara?.play) lara.play(msg.b64);
        // Option debug : télécharger automatiquement
        // const blob = b64toBlob(msg.b64, 'audio/wav'); new Audio(URL.createObjectURL(blob)).play();
        break;
      }

      default:
        break;
    }
    function b64toBlob(b64, mime='audio/wav') {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], {type: mime});
}

  });
}

// =====================
// Transcription WebSocket
// =====================
function connectTranscriptionWebSocket() {
  if (transcriptionSocket &&
      (transcriptionSocket.readyState === WebSocket.OPEN ||
       transcriptionSocket.readyState === WebSocket.CONNECTING)) {
    return; // déjà en cours
  }

  transcriptionSocket = new WebSocket('ws://localhost:8000/transcribe');

  transcriptionSocket.onopen = () => {
    console.log('[Transcription] WS connected');

    transcriptionSocket.send(JSON.stringify({
      peer_id:   myPeerId,
      sampleRate: audioContext ? audioContext.sampleRate : 16000,
      channels:  1,
      language:  'en'
    }));
  };

  transcriptionSocket.onmessage = (event) => {
    const transcriptText = event.data;
    // afficher localement
    const line = document.createElement('div');
    line.textContent = `Me (STT): ${transcriptText}`;
    transcriptDiv.appendChild(line);
    transcriptDiv.scrollTop = transcriptDiv.scrollHeight;

    // relayer aux autres via signalling
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'transcription',
        room: roomId,
        text: transcriptText
      }));
    }
  };

  transcriptionSocket.onerror = (error) => {
    console.error('[Transcription] WS error:', error);
  };

  transcriptionSocket.onclose = () => {
    console.log('[Transcription] WS closed');
  };
}

// =====================
// PeerConnection helper
// =====================
async function createPeerConnection(peerId, isCaller) {
  if (peers.has(peerId) || peerId === myPeerId) return;
  console.log('[Peer] create PC for', peerId, 'caller?', isCaller);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  peers.set(peerId, pc);

  pc.onnegotiationneeded = async () => {
     try {
       const offer = await pc.createOffer();
       await pc.setLocalDescription(offer);
       socket.send(JSON.stringify({
         type:   'signal',
         to:     peerId,
         signal: pc.localDescription
       }));
     } catch (e) { console.error('negotiationneeded', e); }
   };
   // Pistes locales (cam + micro)
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  // ICE -> signalling
   if (lara?.track) {
    pc.addTrack(lara.track, new MediaStream([lara.track]));
  }
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.send(JSON.stringify({
        type:   'signal',
        to:     peerId,
        signal: candidate
      }));
    }
  };

  // Remote media
  const remoteVid = document.createElement('video');
  remoteVid.id          = `remote-${peerId}`;
  remoteVid.autoplay    = true;
  remoteVid.playsinline = true;
  remoteVid.muted       = false;
  videosDiv.appendChild(remoteVid);

  pc.ontrack = ({ streams }) => {
    console.log('[Peer] ontrack from', peerId);
    remoteVid.srcObject = streams[0];
  };

  // Only callers send offer
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

// =====================
// Hangup
// =====================
hangupBtn.addEventListener('click', () => {
  if (transcriptionSocket) {
    transcriptionSocket.close();
    transcriptionSocket = null;
  }
  if (audioProcessor) {
    audioProcessor.disconnect();
    audioProcessor = null;
  }
  if (audioContext) {
    audioContext.close().catch(console.error);
    audioContext = null;
  }
  peers.forEach(pc => pc.close());
  peers.clear();
  document.querySelectorAll('[id^="remote-"]').forEach(el => el.remove());
  console.log('[Hangup] All connections closed');
});

// =====================
// Chat send
// =====================
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
txt.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') btn.click();
});

// =====================
// Boot
// =====================
(async () => {
  await startLocalStream();
  startSignalling();
  console.log('[Init] ready for mesh + chat + transcription');
})();
