// ai/lara.js
'use strict';

/**
 * Initialise une piste MediaStream contenant l’audio de Lara
 * et renvoie { track, play(b64) }.
 *
 * Implémentation : on utilise Web Audio API
 *   - un AudioContext commun (passé en paramètre)
 *   - un MediaStreamDestination pour obtenir une vraie piste WebRTC
 *   - decodeAudioData → BufferSource → destination
 */
export function initLaraAudio(audioContext) {
  const destination = audioContext.createMediaStreamDestination();
  const track       = destination.stream.getAudioTracks()[0];

  /**
   * Joue un WAV base64 provenant de /ask_speech.
   * Pas de pré-chargement cumulatif : chaque appel crée un BufferSource jetable.
   */
  async function play(b64) {
    try {
      const binary  = atob(b64);
      const bytes   = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const buffer  = await audioContext.decodeAudioData(bytes.buffer);

      const source  = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);        // vers la piste WebRTC
      source.connect(audioContext.destination); // pour retour local
      source.start();
    } catch (e) {
      console.error('[Lara] play error', e);
    }
  }

  return { track, play };
}
