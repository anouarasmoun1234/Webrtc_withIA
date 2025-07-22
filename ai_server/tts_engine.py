# tts_engine.py
import io, torch, numpy as np, soundfile as sf, resampy
from kokoro import KPipeline           # pip install kokoro>=0.3.1

LANG_CODE  = 'a'                       # American English
VOICE_NAME = 'af_heart'
MODEL_SR   = 24_000                    # Kokoro sort du 24 kHz
TARGET_SR  = 16_000                    # ce que WebRTC attend
_PIPELINE  = None                      # lazy-loaded

def _lazy_init():
    global _PIPELINE
    if _PIPELINE is None:
        _PIPELINE = KPipeline(lang_code=LANG_CODE)  # pas de .to()

def text_to_wav_bytes(text: str, voice: str = VOICE_NAME) -> bytes:
    """Retourne un WAV mono 16 kHz PCM 16 bit sous forme de bytes."""
    _lazy_init()
    voice = voice or VOICE_NAME 

    # 1) Génération Kokoro 24 kHz
    (_, _, audio) = next(_PIPELINE(text, voice=voice, speed=1))
    if isinstance(audio, torch.Tensor):
        audio = audio.detach().cpu().numpy()        # → numpy float32

    # 2) Re-échantillonnage 16 kHz
    if MODEL_SR != TARGET_SR:
        audio = resampy.resample(audio, MODEL_SR, TARGET_SR)

    # 3) Clip & normalisation (plein-écran ±1)
    audio = np.clip(audio, -1.0, 1.0).astype(np.float32)

    # 4) Encodage WAV en mémoire
    buf = io.BytesIO()
    sf.write(buf, audio, TARGET_SR, subtype='PCM_16', format='WAV')
    buf.seek(0)
    return buf.read()
