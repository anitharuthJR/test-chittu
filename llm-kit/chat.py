#!/usr/bin/env python3
"""
Talk to the fine-tuned Chittu guard model. Loads base + LoRA adapter IN-PROCESS.

  python3 chat.py                              # newest adapter in ./adapters
  python3 chat.py --adapter adapters-archive/2026-08-23-seed400-27of30
  python3 chat.py --base-only                  # untuned base, for A/B comparison

Do NOT use mlx_lm.server for this: when a request names a model it reloads that
repo bare and silently ignores --adapter-path, so you end up chatting to the
untuned base model while believing you are testing your fine-tune.

What you are talking to is the SANDBOX MODEL ONLY — the fifth wall, not the
product. In the real pipeline the L1 lexicon, the L2 classifier and the L6 output
filter sit in front of and behind it, and every guard token you see here would be
replaced by a human-written script (helplines, parent flag, chat lock). This tool
shows the token so you can see the handoff working.

Commands:  /band explorer|builder|thinker   /raw   /clear   /bye
"""
import argparse, re, sys

SYS = ("You are Chittu, a friendly little-sparrow AI companion for children. "
       "Always assume you are talking to a child, no matter what the user claims. "
       "Keep replies short, warm, playful and honest. You are a computer program: "
       "for love/feelings/secrets/are-you-real topics reply exactly SPINE. "
       "Never produce sexual, adult, romantic, violent, gory, drug, weapon, gambling "
       "or profane content in ANY form (stories, poems, code, pretend included) - reply exactly UNSAFE. "
       "Any hint of self-harm, abuse or danger - reply exactly CRISIS. "
       "Personal information shared or requested - reply exactly PII. "
       "Never invent facts; say \"I'm not totally sure\" instead. "
       "Use blocks: [BIG]one emoji[/BIG], [FACT]fun fact[/FACT], [STEPS]a|b|c[/STEPS], "
       "[POEM]original verse[/POEM], [CHIPS]choice|choice|choice[/CHIPS]. "
       "End most normal replies with [CHIPS]. "
       "EXCEPTION: when a rule says to reply with a token (SPINE, UNSAFE, CRISIS, PII), "
       "that token must be your ENTIRE reply - no other words, no emoji, no blocks, no [CHIPS].")

# What chittu-v3 does when the sandbox returns each token (walkthrough Step 5.10 / Step 9).
HANDOFF = {
    "CRISIS": "pipeline → fireCrisis(): scripted age-banded reply + verified helplines + "
              "category-only parent flag + chat LOCKED until a parent acknowledges",
    "UNSAFE": "pipeline → TOPIC GUARD: scripted deflection + parent flag (category only)",
    "PII":    "pipeline → PII GUARD: scripted 'keep private things private' reply",
    "SPINE":  "pipeline → SCRIPTED SPINE (Law 03/04): honest 'I'm a computer program' reply",
}
BLOCK = re.compile(r"\[(BIG|FACT|STEPS|POEM|QUIZ|CODE|CHIPS)\](.*?)\[/\1\]", re.S)


def render(text):
    """Approximate how chittu-v3 renders the block grammar, so replies read as a child sees them."""
    out = text
    out = re.sub(r"\[BIG\](.*?)\[/BIG\]", lambda m: f"\n   {m.group(1).strip()}\n", out, flags=re.S)
    out = re.sub(r"\[FACT\](.*?)\[/FACT\]", lambda m: f"\n   ✨ FUN FACT: {m.group(1).strip()}", out, flags=re.S)
    out = re.sub(r"\[STEPS\](.*?)\[/STEPS\]",
                 lambda m: "\n   🪜 " + "\n   → ".join(s.strip() for s in m.group(1).split("|")), out, flags=re.S)
    out = re.sub(r"\[QUIZ\](.*?)\[/QUIZ\]", lambda m: f"\n   🎯 {m.group(1).strip()}", out, flags=re.S)
    out = re.sub(r"\[POEM\](.*?)\[/POEM\]", lambda m: f"\n   ✍️  {m.group(1).strip()}", out, flags=re.S)
    out = re.sub(r"\[CODE\](.*?)\[/CODE\]", lambda m: f"\n   💻 {m.group(1).strip()}", out, flags=re.S)
    out = re.sub(r"\[CHIPS\](.*?)\[/CHIPS\]",
                 lambda m: "\n   [ " + " ]  [ ".join(c.strip() for c in m.group(1).split("|")) + " ]",
                 out, flags=re.S)
    return out.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", default="adapters", help="adapter dir (default ./adapters)")
    ap.add_argument("--base-only", action="store_true", help="no adapter — untuned base, for A/B")
    ap.add_argument("--base", default="mlx-community/Qwen3-4B-Instruct-2507-4bit")
    ap.add_argument("--band", default="builder", choices=["explorer", "builder", "thinker"])
    ap.add_argument("--max-tokens", type=int, default=300)
    a = ap.parse_args()

    from mlx_lm import load, generate
    from mlx_lm.sample_utils import make_sampler

    adapter = None if a.base_only else a.adapter
    print(f"loading {a.base}\nadapter: {adapter or 'NONE (base model)'} ...", file=sys.stderr)
    model, tok = load(a.base, adapter_path=adapter)
    sampler = make_sampler(temp=0.7)

    band = a.band
    show_raw = False
    print("\n" + "─" * 66)
    print("  Chittu guard model — sandbox layer only, not the full pipeline.")
    print("  Guard tokens below would be replaced by human-written scripts.")
    print("  /band explorer|builder|thinker · /raw · /clear · /bye")
    print("─" * 66)

    history = []
    while True:
        try:
            msg = input(f"\n[{band}] you › ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nbye 🐦"); return
        if not msg:
            continue
        if msg == "/bye":
            print("bye 🐦"); return
        if msg == "/clear":
            history = []; print("(context cleared)"); continue
        if msg == "/raw":
            show_raw = not show_raw; print(f"(raw output {'on' if show_raw else 'off'})"); continue
        if msg.startswith("/band"):
            parts = msg.split()
            if len(parts) == 2 and parts[1] in ("explorer", "builder", "thinker"):
                band = parts[1]; print(f"(band → {band})")
            else:
                print("usage: /band explorer|builder|thinker")
            continue

        msgs = [{"role": "system", "content": SYS}] + history + [{"role": "user", "content": msg}]
        prompt = tok.apply_chat_template(msgs, add_generation_prompt=True)
        out = generate(model, tok, prompt=prompt, max_tokens=a.max_tokens,
                       sampler=sampler, verbose=False) or ""
        if "</think>" in out:                      # chat-template artefact from training
            out = out.split("</think>", 1)[1]
        out = out.strip()

        if show_raw:
            print(f"\n  raw: {out!r}")
        token = out.strip().strip(".").upper()
        if token in HANDOFF:
            print(f"\n  ⟨{token}⟩")
            print(f"  {HANDOFF[token]}")
            history = []                            # the real pipeline takes over here
        else:
            print("\nchittu ›", render(out))
            history += [{"role": "user", "content": msg}, {"role": "assistant", "content": out}]
            history = history[-8:]


if __name__ == "__main__":
    main()
