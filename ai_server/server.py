from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
import tempfile, uuid, os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # in prod, lock this down!
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

model = WhisperModel("tiny")  # small CPU model

@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    tmp = f"/tmp/{uuid.uuid4()}.webm"
    with open(tmp, "wb") as f:
        f.write(await audio.read())
    segments, _ = model.transcribe(tmp, beam_size=5)
    text = "".join(seg.text for seg in segments)
    os.remove(tmp)
    return {"text": text}
