# ai_server/server.py
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel

# ─── CONFIG ────────────────────────────────────────────────────────────────
BASE_MODEL     = "gpt2"
ADAPTER_DIR    = "lora_adapter"   # where finetune_lora.py saved your adapter
DEVICE         = "cpu"

# ─── LOAD TOKENIZER & MODEL ─────────────────────────────────────────────────
print("Loading tokenizer + base model…")
tokenizer = AutoTokenizer.from_pretrained(ADAPTER_DIR)
print("Loading base model + LoRA adapter…")
base = AutoModelForCausalLM.from_pretrained(BASE_MODEL)
model = PeftModel.from_pretrained(base, ADAPTER_DIR)
model.to(DEVICE).eval()

# ─── FASTAPI SETUP ─────────────────────────────────────────────────────────
app = FastAPI(title="LoRA-tuned GPT2 Inference")

class GenerationRequest(BaseModel):
    prompt: str
    max_length: int = 128

class GenerationResponse(BaseModel):
    text: str

@app.post("/generate", response_model=GenerationResponse)
def generate(req: GenerationRequest):
    inputs = tokenizer(req.prompt, return_tensors="pt").to(DEVICE)
    out    = model.generate(
        **inputs,
        max_length=req.max_length,
        do_sample=True,
        top_p=0.9,
        temperature=0.8,
        pad_token_id=tokenizer.eos_token_id
    )
    text = tokenizer.decode(out[0], skip_special_tokens=True)
    return GenerationResponse(text=text)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
