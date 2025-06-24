#!/usr/bin/env python
# ai_server/finetune_lora.py

from datasets import load_dataset
from transformers import (
    AutoTokenizer,
    AutoModelForCausalLM,
    Trainer,
    TrainingArguments
)
from peft import LoraConfig, get_peft_model

# ─── CONFIG ────────────────────────────────────────────────────────────────
BASE_MODEL    = "gpt2"               # small GPT-2 base
DATA_PATH     = "domain.jsonl"       # your 5–10 examples file
OUTPUT_DIR    = "lora_adapter"       # where to save your adapter
MAX_LENGTH    = 128                  # truncate/pad to this length
BATCH_SIZE    = 2                    # tiny batch so it fits CPU RAM
EPOCHS        = 3
LEARNING_RATE = 2e-4

# ─── LOAD & TOKENIZE ────────────────────────────────────────────────────────
# 1) load your tiny domain dataset
ds = load_dataset("json", data_files=DATA_PATH, split="train")

# 2) tokenizer + pad_token
tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
tokenizer.pad_token = tokenizer.eos_token

def preprocess(examples):
    # each record has "prompt" and "completion"
    texts = [
        prompt + completion + tokenizer.eos_token
        for prompt, completion in zip(examples["prompt"], examples["completion"])
    ]
    enc = tokenizer(
        texts,
        max_length=MAX_LENGTH,
        padding="max_length",
        truncation=True
    )
    # for causal LM, labels == input_ids
    enc["labels"] = enc["input_ids"].copy()
    return enc

tokenized = ds.map(preprocess, batched=True, remove_columns=ds.column_names)

# ─── MODEL & LoRA ──────────────────────────────────────────────────────────
# 3) base model (FP32)
model = AutoModelForCausalLM.from_pretrained(BASE_MODEL)
model.resize_token_embeddings(len(tokenizer))

# 4) attach a small LoRA adapter
lora_cfg = LoraConfig(
    r=8,
    lora_alpha=16,
    target_modules=["c_attn", "q_proj", "v_proj"],  # GPT2’s attention proj layers
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM"
)
model = get_peft_model(model, lora_cfg)

# ─── TRAIN ──────────────────────────────────────────────────────────────────
training_args = TrainingArguments(
    output_dir=OUTPUT_DIR,
    per_device_train_batch_size=BATCH_SIZE,
    num_train_epochs=EPOCHS,
    learning_rate=LEARNING_RATE,
    logging_steps=5,
    save_steps=50,
    save_total_limit=1,
    fp16=False,
    push_to_hub=False,
)

trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=tokenized
)

if __name__ == "__main__":
    trainer.train()
    model.save_pretrained(OUTPUT_DIR)
    tokenizer.save_pretrained(OUTPUT_DIR)
    print(f"▶ LoRA adapter saved in ./{OUTPUT_DIR}")
