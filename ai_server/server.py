from fastapi import FastAPI, WebSocket
import numpy as np
from faster_whisper import WhisperModel
import asyncio
import logging
import time
import wave
import tempfile
import os
from collections import deque
import threading
from queue import Queue

# Configuration du logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("WhisperServer")

app = FastAPI()

# File d'attente pour le traitement audio
audio_queue = Queue()
results_queue = Queue()

# Modèle Whisper global
whisper_model = None

# Contextes par client
client_contexts = {}

# Initialisation du modèle
@app.on_event("startup")
async def startup_event():
    global whisper_model
    logger.info("Loading Whisper model...")
    # Utilisation d'un modèle plus léger pour le CPU
    whisper_model = WhisperModel(
        "tiny.en",  # Modèle optimisé pour l'anglais
        device="cpu",
        compute_type="int8",
        cpu_threads=4
    )
    logger.info("Model loaded. Starting worker threads...")
    
    # Démarrer les workers
    for i in range(2):  # 2 threads de traitement
        threading.Thread(target=transcription_worker, daemon=True).start()

# Worker de transcription
#car le whisper fonctionne mieux avec les fichiers wav qu'avec de buffers 
def transcription_worker():
    while True:
        try:
            # Récupérer une tâche de la file d'attente
            task = audio_queue.get()
            if task is None:
                break
                
            client_id, audio_data, sample_rate, context = task
            logger.info(f"Processing audio for {client_id} ({len(audio_data)/sample_rate:.2f}s)")
            
            # Créer un fichier WAV temporaire
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as temp_wav:
                create_wav_file(temp_wav.name, audio_data, sample_rate)
                
                # Transcription avec contexte
                segments, info = whisper_model.transcribe(
                    temp_wav.name,
                    language="en",
                    beam_size=5,
                    vad_filter=True,
                    no_speech_threshold=0.4,
                    initial_prompt=context[-200:] if context else ""
                )
                
                full_text = " ".join(segment.text for segment in segments).strip()
                
                if full_text:
                    logger.info(f"Transcription for {client_id}: {full_text}")
                    # Mettre à jour le contexte
                    new_context = (context + " " + full_text).strip()
                    client_contexts[client_id] = new_context
                    
                    # Envoyer le résultat
                    results_queue.put((client_id, full_text))
            
            audio_queue.task_done()
        except Exception as e:
            logger.error(f"Transcription worker error: {str(e)}")

# Création de fichier WAV
def create_wav_file(filename, audio_data, sample_rate):
    with wave.open(filename, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)  # 16-bit PCM
        wav_file.setframerate(sample_rate)
        wav_file.writeframes((audio_data * 32767).astype(np.int16).tobytes())

# Gestionnaire WebSocket
@app.websocket("/transcribe")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    client_id = id(websocket)
    logger.info(f"Client connected: {client_id}")
    
    # Initialisation du contexte client
    client_contexts[client_id] = ""
    buffer = np.array([], dtype=np.float32)
    sample_rate = 16000
    last_process_time = time.time()
    
    try:
        # Recevoir la configuration audio
        config = await websocket.receive_json()
        sample_rate = config.get("sampleRate", 16000)
        logger.info(f"Audio config for {client_id}: sample_rate={sample_rate}")
        
        # Boucle principale de traitement
        while True:
            try:
                # Recevoir les données audio avec timeout
                data = await asyncio.wait_for(websocket.receive_bytes(), timeout=3.0)
                
                # Convertir en float32
                pcm_data = np.frombuffer(data, dtype=np.float32)
                buffer = np.concatenate((buffer, pcm_data))
                
                # Vérifier si on a assez de données pour traiter
                buffer_duration = len(buffer) / sample_rate
                current_time = time.time()
                time_since_last_process = current_time - last_process_time
                
                # Déclencher le traitement si:
                # - On a au moins 3 secondes d'audio
                # - Ou 3 secondes se sont écoulées depuis le dernier traitement
                if buffer_duration >= 3.0 or (time_since_last_process >= 3.0 and len(buffer) > 0):
                    # Prélever un chunk de 5 secondes max
                    chunk_size = min(len(buffer), int(5.0 * sample_rate))
                    process_chunk = buffer[:chunk_size]
                    
                    # Garder le reste dans le buffer (pour continuité)
                    buffer = buffer[chunk_size:]
                    
                    # Ajouter à la file d'attente de traitement
                    audio_queue.put((
                        client_id,
                        process_chunk,
                        sample_rate,
                        client_contexts[client_id]
                    ))
                    
                    last_process_time = current_time
                    
                    # Vérifier et envoyer les résultats disponibles
                    while not results_queue.empty():
                        cid, text = results_queue.get()
                        if cid == client_id:
                            await websocket.send_text(text)
                        results_queue.task_done()
                
            except asyncio.TimeoutError:
                # Vérifier les résultats même en timeout
                while not results_queue.empty():
                    cid, text = results_queue.get()
                    if cid == client_id:
                        await websocket.send_text(text)
                    results_queue.task_done()
                
                # Forcer le traitement si buffer non vide après 5s d'inactivité
                if time.time() - last_process_time > 5.0 and len(buffer) > 0:
                    process_chunk = buffer.copy()
                    buffer = np.array([], dtype=np.float32)
                    
                    audio_queue.put((
                        client_id,
                        process_chunk,
                        sample_rate,
                        client_contexts[client_id]
                    ))
                    last_process_time = time.time()
    
    except Exception as e:
        if "1000" in str(e) or "1001" in str(e):
            logger.info(f"Client {client_id} disconnected normally")
        else:
            logger.error(f"Error for client {client_id}: {str(e)}")
    finally:
        # Nettoyage
        if client_id in client_contexts:
            del client_contexts[client_id]
        logger.info(f"Transcription session ended for {client_id}")