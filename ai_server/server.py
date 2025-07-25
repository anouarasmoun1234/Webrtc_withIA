

from fastapi import FastAPI, WebSocket, Body
import numpy as np
from faster_whisper import WhisperModel
import asyncio
import logging
import time
import wave
import tempfile
import csv, datetime, os
import threading
from queue import Queue
import io
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
from tts_engine import text_to_wav_bytes
import base64
from pydantic import BaseModel
import  traceback
from lc_engine import run_lara 
import google.api_core.exceptions as gexc
import google.generativeai as genai
genai.configure(api_key=os.environ["GOOGLE_API_KEY"])
GEMINI_MODEL = "ggemini-1.5-flash"  



# Chat haute vitesse, gratuit :
PREFERRED = "models/gemini-1.5-flash"
FALLBACK  = "models/gemini-1.5-pro"


CSV_PATH = "transcript.csv"

# ------------------------------------------------------------------
# logging
# ------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("WhisperServer")

app = FastAPI()

DEFAULT_VOICE = "af_heart"

class TTSReq(BaseModel):
    text:  str
    voice: str | None = DEFAULT_VOICE     # valeur par défaut

class TTSResp(BaseModel):
    wav_b64: str                          
# ------------------------------------------------------------------
# CSV persistence
# ------------------------------------------------------------------
def save_segment(peer_id: str, text: str):
    if not text:
        return
    newfile = not os.path.exists(CSV_PATH)
    with open(CSV_PATH, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if newfile:
            w.writerow(["timestamp", "peer_id", "text"])
        w.writerow([datetime.datetime.utcnow().isoformat(), peer_id, text])

# ------------------------------------------------------------------
# Queues + model
# ------------------------------------------------------------------
audio_queue   = Queue()
results_queue = Queue()
whisper_model = None

# client_contexts: client_id -> {"peer": str, "context": str}
client_contexts = {}

# ------------------------------------------------------------------
# Startup: load model + worker threads

@app.on_event("startup")
async def startup_event():
    global whisper_model
    logger.info("Loading Whisper model...")
    whisper_model = WhisperModel(
        "base.en",
        device="cpu",
        compute_type="int8",
        cpu_threads=4
    )
    logger.info("Model loaded. Starting worker threads...")
    for i in range(2):
        threading.Thread(target=transcription_worker, daemon=True).start()

# ------------------------------------------------------------------
# Worker thread: pulls audio chunks, runs Whisper
# ------------------------------------------------------------------
def transcription_worker():
    while True:
        try:
            task = audio_queue.get()
            if task is None:
                break

            client_id, audio_data, sample_rate, context = task
            dur = len(audio_data) / float(sample_rate)
            logger.info(f"Processing audio for {client_id} ({dur:.2f}s)")

            # write temp wav
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as temp_wav:
                create_wav_file(temp_wav.name, audio_data, sample_rate)

                segments, info = whisper_model.transcribe(
                    temp_wav.name,
                    language="en",
                    beam_size=5,
                    vad_filter=True,
                    no_speech_threshold=0.4,
                    initial_prompt=context[-200:] if context else ""
                )

            full_text = " ".join(seg.text for seg in segments).strip()

            if full_text:
                logger.info(f"Transcription for {client_id}: {full_text}")
                # update context
                ctx = client_contexts.get(client_id)
                if ctx:
                    ctx["context"] = (ctx["context"] + " " + full_text).strip()
                    save_segment(ctx["peer"], full_text)
                results_queue.put((client_id, full_text))

            audio_queue.task_done()
        except Exception as e:
            logger.exception(f"Transcription worker error: {e}")

# ------------------------------------------------------------------
def create_wav_file(filename, audio_data, sample_rate):
    with wave.open(filename, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)  # 16-bit PCM
        wav_file.setframerate(sample_rate)
        wav_file.writeframes((audio_data * 32767).astype(np.int16).tobytes())

# ------------------------------------------------------------------
# WebSocket endpoint

@app.websocket("/transcribe")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    client_id = id(websocket)
    logger.info(f"Client connected: {client_id}")

    # handshake: config + peer_id
    cfg = await websocket.receive_json()
    peer_id     = cfg.get("peer_id", f"peer-{client_id}")
    sample_rate = cfg.get("sampleRate", 16000)
    logger.info(f"Audio config for {client_id}: sample_rate={sample_rate}, peer_id={peer_id}")

    client_contexts[client_id] = {"peer": peer_id, "context": ""}

    buffer = np.array([], dtype=np.float32)
    last_process_time = time.time()

    try:
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_bytes(), timeout=3.0)
            except asyncio.TimeoutError:
                # flush any ready results
                while not results_queue.empty():
                    cid, text = results_queue.get()
                    if cid == client_id:
                        await websocket.send_text(text)
                    results_queue.task_done()

                # force process after idle 5s
                if time.time() - last_process_time > 5.0 and len(buffer) > 0:
                    audio_queue.put((client_id, buffer.copy(), sample_rate,
                                     client_contexts[client_id]["context"]))
                    buffer = np.array([], dtype=np.float32)
                    last_process_time = time.time()
                continue

            # append audio
            pcm_data = np.frombuffer(data, dtype=np.float32)
            buffer = np.concatenate((buffer, pcm_data))

            # process if ≥3s audio or ≥3s since last process
            buf_dur = len(buffer) / sample_rate
            now = time.time()
            if buf_dur >= 3.0 or (now - last_process_time >= 3.0 and len(buffer) > 0):
                chunk_size = min(len(buffer), int(5.0 * sample_rate))
                process_chunk = buffer[:chunk_size]
                buffer = buffer[chunk_size:]

                audio_queue.put((client_id, process_chunk, sample_rate,
                                 client_contexts[client_id]["context"]))
                last_process_time = now

                # drain results
                while not results_queue.empty():
                    cid, text = results_queue.get()
                    if cid == client_id:
                        await websocket.send_text(text)

                    results_queue.task_done()

    except Exception as e:
        if "1000" in str(e) or "1001" in str(e):
            logger.info(f"Client {client_id} disconnected normally")
        else:
            logger.exception(f"Error for client {client_id}: {e}")
    finally:
        client_contexts.pop(client_id, None)
        logger.info(f"Transcription session ended for {client_id}")
@app.post("/tts", response_model=TTSResp)
async def tts_endpoint(req: TTSReq = Body(...)):
    # 1) synthèse → wav (bytes)
    wav = text_to_wav_bytes(req.text, req.voice)

    # 2) encodage base64 pour transporter dans du JSON
    b64 = base64.b64encode(wav).decode()

    
    return {"wav_b64": b64}

# === LARA Q&A + SPEECH  =====================

from typing import Optional

class AskReq(BaseModel):
    question: str
    window: int = 5                 # minutes de contexte
    voice: Optional[str] = DEFAULT_VOICE

class AskResp(BaseModel):
    text: str
    wav_b64: str

def load_recent_text(minutes: int) -> str:
    """Concatène les segments du transcript.csv dans la fenêtre temporelle demandée."""
    if not os.path.exists(CSV_PATH):
        return ""
    cutoff = datetime.datetime.utcnow() - datetime.timedelta(minutes=minutes)
    rows = []
    with open(CSV_PATH, newline='', encoding='utf-8') as f:
        r = csv.DictReader(f)
        for row in r:
            try:
                ts = datetime.datetime.fromisoformat(row["timestamp"])
            except Exception:
                continue
            if ts >= cutoff:
                rows.append(f'{row["peer_id"]}: {row["text"]}')
    return "\n".join(rows[-200:])  # borne de sécurité

# --- implémentation LLM ---
'''
def call_llm(prompt: str) -> str:
    for mdl in (PREFERRED, FALLBACK):
        try:
            model = genai.GenerativeModel(mdl)
            resp  = model.generate_content(
                prompt,
                generation_config={"max_output_tokens": 256, "temperature": 0.3}
            )
            return resp.text.strip()
        except gexc.ResourceExhausted:
            logger.warning("Quota hit on %s → essai modèle suivant", mdl)
            continue
        except gexc.GoogleAPIError as e:
            logger.warning("Erreur %s sur %s → retry 5 s", e, mdl)
            time.sleep(5)
            continue
    # Tous les essais Gemini KO → LoRA local
    return call_lora_local(prompt)     # → ta fonction LoRA (à adapter)
'''
# --- mini‑wrapper LoRA (si tu ne l’as pas déjà) ---
def call_lora_local(prompt: str) -> str:
    # ICI le code qui interroge ton GPT‑2 finetuné.
    # Pour l’instant on renvoie juste un écho court.
    return "(Lara‑LoRA) " + prompt[-120:]
@app.post("/ask_speech", response_model=AskResp)
async def ask_speech(req: AskReq = Body(...)):
    """
    Reçoit une question utilisateur, récupère du contexte transcript, 
    produit une réponse texte (LLM stub pour l'instant), puis synthèse vocale.
    """
    context = load_recent_text(req.window)
    prompt  = (
        "You are Lara, a helpful AI inside a video-conference. \n"
        "Answer briefly and clearly.\n\n"
        "=== Contexte récent ===\n"
        f"{context}\n"
        "=======================\n\n"
        f"Question: {req.question}\n"
        "Réponse:"
    )
    answer_text = run_lara(req.question, context)  
    wav_bytes   = text_to_wav_bytes(answer_text, req.voice or DEFAULT_VOICE)
   
    b64         = base64.b64encode(wav_bytes).decode("utf-8")
    return {"text": answer_text, "wav_b64": b64}

# --------------------------------------------
# ===  LARA SUMMARY  =========================

from typing import Annotated
from fastapi import Query

class SummaryResp(BaseModel):
    text: str
    wav_b64: str

@app.get("/summary", response_model=SummaryResp)
async def summary_endpoint(
    window: Annotated[int, Query(ge=1, le=60)] = 5,
    voice:  str = DEFAULT_VOICE
):
    """
    Return the summary of the meeting
    in the last *window* minutes + TTS.
    """

    context = load_recent_text(window)
    prompt  = (
        "You are Lara, a helpful AI inside a video-conference. \n"
        f"Summarize the following discussion in three clear sentences. :\n\n{context}"
    )
    summary = run_lara(prompt, "")          # pas de context supplémentaire
    wav     = text_to_wav_bytes(summary, voice)
    b64     = base64.b64encode(wav).decode()
    return {"text": summary, "wav_b64": b64}
