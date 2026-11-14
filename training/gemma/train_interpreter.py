"""Full fine-tune of a small Gemma on question -> JSON call pairs (see interp_format.py for the file format).

Loss is computed on the assistant turn only; the prompt is rendered with the tokenizer's own chat template.
"""
import argparse
import json
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments

from interp_format import completion_text, load_pairs, load_schema, prompt_text


class PairDataset(torch.utils.data.Dataset):
    def __init__(self, rows, tok, schema, max_length):
        self.items = []
        self.dropped = 0
        for row in rows:
            prompt = tok(prompt_text(tok, row), add_special_tokens=False).input_ids
            completion = tok(completion_text(row, schema), add_special_tokens=False).input_ids
            if len(prompt) + len(completion) > max_length:
                self.dropped += 1
                continue
            self.items.append((prompt + completion, [-100] * len(prompt) + completion))

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        ids, labels = self.items[i]
        return {"input_ids": ids, "labels": labels}


def collate(pad_id):
    def fn(batch):
        width = max(len(b["input_ids"]) for b in batch)
        ids = torch.full((len(batch), width), pad_id, dtype=torch.long)
        labels = torch.full((len(batch), width), -100, dtype=torch.long)
        mask = torch.zeros((len(batch), width), dtype=torch.long)
        for i, b in enumerate(batch):
            n = len(b["input_ids"])
            ids[i, :n] = torch.tensor(b["input_ids"])
            labels[i, :n] = torch.tensor(b["labels"])
            mask[i, :n] = 1
        return {"input_ids": ids, "attention_mask": mask, "labels": labels}
    return fn


class CompletionLossTrainer(Trainer):
    """Projects only the completion positions onto the vocabulary.

    Gemma's vocabulary has 262k entries, so logits for every prompt position cost
    about 1 MB per token and dominate memory and time.
    """

    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        labels = inputs["labels"][:, 1:]
        hidden = model.model(input_ids=inputs["input_ids"],
                             attention_mask=inputs["attention_mask"]).last_hidden_state[:, :-1]
        keep = labels != -100
        logits = model.lm_head(hidden[keep]).float()
        cap = getattr(model.config, "final_logit_softcapping", None)
        if cap:
            logits = torch.tanh(logits / cap) * cap
        loss = torch.nn.functional.cross_entropy(logits, labels[keep])
        return (loss, None) if return_outputs else loss


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--train", required=True)
    ap.add_argument("--schema", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--max-length", type=int, default=512)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-gpu-gb", type=float, default=0, help="fail instead of growing past this on a shared GPU")
    args = ap.parse_args()
    if args.max_gpu_gb:
        total = torch.cuda.get_device_properties(0).total_memory / 2**30
        torch.cuda.set_per_process_memory_fraction(args.max_gpu_gb / total)

    tok = AutoTokenizer.from_pretrained(args.model)
    schema = load_schema(args.schema)
    data = PairDataset(load_pairs(args.train, args.limit), tok, schema, args.max_length)
    lengths = sorted(len(ids) for ids, _ in data.items)
    print(f"examples {len(data)} dropped_too_long {data.dropped} "
          f"tokens p50 {lengths[len(lengths) // 2]} max {lengths[-1]}", flush=True)

    # float32 weights with bf16 autocast: at lr 5e-5 most updates would round away in bf16 weights
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32)
    steps = int(len(data) / args.batch_size * args.epochs)
    targs = TrainingArguments(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_steps=max(1, steps // 20),
        bf16=True,
        optim="adamw_torch_fused",
        logging_steps=max(1, steps // 20),
        save_strategy="no",
        report_to="none",
        disable_tqdm=True,
        dataloader_num_workers=2,
    )
    trainer = CompletionLossTrainer(model=model, args=targs, train_dataset=data, data_collator=collate(tok.pad_token_id))
    torch.cuda.reset_peak_memory_stats()
    start = time.time()
    result = trainer.train()
    seconds = time.time() - start
    losses = [h["loss"] for h in trainer.state.log_history if "loss" in h]
    summary = {
        "examples": len(data),
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "train_seconds": round(seconds, 1),
        "examples_per_second": round(len(data) * args.epochs / seconds, 1),
        "trainer_samples_per_second": result.metrics.get("train_samples_per_second"),
        "peak_gpu_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2),
        "loss_first": losses[0] if losses else None,
        "loss_last": losses[-1] if losses else None,
        "losses": losses,
    }
    print(json.dumps(summary), flush=True)
    trainer.save_model(args.out)
    tok.save_pretrained(args.out)
    with open(f"{args.out}/train_summary.json", "w") as f:
        json.dump(summary, f, indent=1)


if __name__ == "__main__":
    main()
