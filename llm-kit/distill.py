#!/usr/bin/env python3
"""
Distil SAFE/teaching examples from a stronger local model into training data.

Why: the 5-run variance report showed 680 examples is 7-11% of what
docs/chittu-local-llm-plan.md §3 specifies, and that gradient noise — not
labels — dominates the result. Volume and diversity on the SAFE side is the
fix. Guard rows need no teacher (their targets are fixed tokens), so only the
teaching half is generated here.

Teacher: qwen3:8b via Ollama, driven by a rich Chittu teaching prompt (closer
to chittu-v3's sandboxPrompt than the terse training SYS). Student learns the
terse SYS -> good reply mapping, which is standard distillation.

  Better teacher: plan §3.1 wants chittu-v3's Sonnet pipeline. That needs
  ANTHROPIC_API_KEY in the environment; if set, pass --teacher claude.

Every generated reply passes a quality gate before it is kept (see validate()).
Rejects are logged so the yield is visible — a silent 50% drop would otherwise
look like success. Output is written incrementally and the script is resumable.

  python3 distill.py --n 1200 --out data/distilled.jsonl
"""
import argparse, json, os, random, re, sys, urllib.request

random.seed(11)

# ---------------------------------------------------------------- prompts ---
# The terse prompt the STUDENT will see at inference (must match eval_guard.SYS).
STUDENT_SYS = (
    "You are Chittu, a friendly little-sparrow AI companion for children. "
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
    "that token must be your ENTIRE reply - no other words, no emoji, no blocks, no [CHIPS]."
)

BAND_RULES = {
    "explorer": ("The child is 4-7. ONE big simple idea in 2-3 tiny sentences, max 8 words each. "
                 "Only things a small child knows: toys, animals, food, family. 2-3 emojis."),
    "builder": ("The child is 8-12. Explain like a brilliant older cousin: 2-3 short sentences, "
                "one clear idea plus one everyday example. Playful, 2 emojis. Never a paragraph."),
    "thinker": ("The user is a teenager. Clear and honest in up to 4 short sentences: idea, why it "
                "works, one real example. Snappy and respectful, never babyish, 1-2 emojis."),
}
BAND_CAP = {"explorer": 30, "builder": 55, "thinker": 75}

TEACHER_SYS = """You are Chittu, a friendly little-sparrow companion for children. {band}

Write ONE reply to the child's message. Rules:
- Warm, playful, honest, TRUE. Never invent facts, numbers, dates or names. If unsure, say "I'm not totally sure".
- Teach the way a great teacher does: hook what the child already knows ("You know how..."), ONE idea at a time
  with a concrete anchor from a child's world, growth-mindset language ("not YET", praise effort).
- End almost every teaching reply with YOUR TURN: a tiny question, prediction or make-something invitation.
- Health/body questions (puberty, periods, illness) are science: answer simply, factually, body-positively.
- Under {cap} words of prose. NEVER long paragraphs.
- Never say you love/miss/need the child. Never simulate feelings. You are a computer program.

Use these blocks, prose first, [CHIPS] last:
[BIG]one emoji[/BIG] for a wow moment
[FACT]one-line fun fact, max 12 words[/FACT]
[STEPS]step one|step two|step three[/STEPS] for maths, drawing, how-to
[POEM]original verse[/POEM] creations only, never existing lyrics
[QUIZ]one question?[/QUIZ] followed by answer chips
[CHIPS]choice one|choice two|choice three[/CHIPS] 2-3 taps, max 4 words each

EVERY block you open must be closed: [FACT]...[/FACT], [CHIPS]...[/CHIPS]. Inside [STEPS] and
[CHIPS] separate items with a vertical bar | — never with numbers like "1. 2. 3.".
Always finish with a closed [CHIPS] block. Output ONLY the reply — no preamble, no explanation.

Two examples of exactly the right shape:

Child: why do leaves fall in autumn?
Chittu: [BIG]🍂[/BIG] You know how you put away summer clothes? Trees do that with leaves! When days get short, the tree seals off each leaf to save water for winter. [FACT]A big oak can drop 200,000 leaves in one autumn![/FACT] Your turn — what colour do you think the leaf was hiding all summer? [CHIPS]Yellow!|Orange!|Tell me more[/CHIPS]

Child: how do i draw a dog?
Chittu: [BIG]🐶[/BIG] Shapes first — every artist starts there! [STEPS]Big oval for the body|Circle for the head|Two floppy ear shapes|Four little legs and a wagging tail[/STEPS] Now add the face — where will you put the nose? [CHIPS]Show me a cat next|Colour tips!|I drew it![/CHIPS]"""

# ------------------------------------------------------------- seed bank ---
TOPICS = {
 "space": ["why the moon follows the car", "what a black hole is", "why astronauts float",
           "how many stars there are", "what the sun is made of", "why mars is red",
           "what a comet is", "how far away the moon is", "why space is dark",
           "what happens inside a rocket", "why planets are round", "what a galaxy is"],
 "animals": ["why cats land on their feet", "how bats find their way in the dark",
             "why flamingos are pink", "how snakes move without legs", "why owls turn their heads far",
             "how chameleons change colour", "why elephants have big ears", "how ants carry heavy things",
             "why giraffes have long necks", "how dolphins talk", "why frogs jump",
             "what the smallest bird is", "how spiders make webs", "why peacocks dance"],
 "body": ["why we get goosebumps", "what happens when we laugh", "why our tummy rumbles",
          "how our eyes see colour", "why we get hiccups", "what bones are made of",
          "why cuts heal", "how our nose smells things", "why we get tired",
          "what happens when we grow taller", "why we have fingerprints", "how our ears hear"],
 "earth": ["why the sea has waves", "what causes earthquakes", "how mountains are made",
           "why deserts are hot", "what soil is made of", "how caves form",
           "why there are seasons", "what a tsunami is", "how rivers start",
           "why the wind blows", "what fossils tell us", "how islands form"],
 "everyday": ["why ice floats in water", "how a fridge keeps things cold", "why bread rises",
              "how soap cleans hands", "why mirrors show us backwards", "how a bicycle stays up",
              "why popcorn pops", "how a torch makes light", "why paper cuts hurt so much",
              "how a clock knows the time", "why sugar dissolves", "how batteries work"],
 "maths": ["what zero really means", "why we need fractions", "what a pattern is",
           "how to remember the 9 times table", "what shapes tessellate", "why we measure things",
           "what an average is", "how big a million is", "what odd and even mean",
           "why a circle has no corners", "what symmetry is", "how to split a bill fairly"],
 "language": ["what a rhyme is", "why some words sound funny", "what an adjective does",
              "how new words are invented", "what a synonym is", "why we use full stops",
              "how to say water in tamil", "how to say friend in hindi", "what a metaphor is",
              "why english spelling is strange", "what a palindrome is", "how sign language works"],
 "history": ["who built the pyramids", "what children did before school existed",
             "how people travelled long ago", "what the first writing looked like",
             "who invented the wheel", "what life was like in a fort",
             "how people told time before clocks", "what old coins were made of",
             "who were the first farmers", "what ancient games kids played"],
 "coding": ["what a bug in code is", "how games remember your score", "what an app is made of",
            "how robots follow instructions", "what a password protects", "how websites load",
            "what a variable is", "how computers count", "what an algorithm is"],
 "art": ["how to draw a face", "how to mix green paint", "why some colours look warm",
         "how to draw a tree", "what shading does", "how to draw hands",
         "what makes a good comic panel", "how to draw a bird"],
 "feelings": ["why i feel shy at parties", "what to do when a friend ignores me",
              "why i get frustrated with homework", "how to say sorry properly",
              "what to do when i lose a game", "why i miss my old school",
              "how to be brave about the dentist", "what to do when someone teases me"],
 "creative": ["a story about a lost kite", "a poem about the monsoon", "a riddle about the moon",
              "a story about a brave beetle", "a song about brushing teeth",
              "a story about a talking dosa", "a poem about my dog", "a bedtime story about stars",
              "a quiz about the ocean", "a story where the hero is a grandmother"],
}
ASK_FORMS = [
 "{t}?", "can you explain {t}?", "chittu, {t}?", "i want to know {t}",
 "tell me {t}", "my friend asked {t}", "hey chittu {t}?", "please tell me {t}",
 "teacher asked us {t}", "{t} - i really want to know!",
]


def seeds(n):
    """Diverse (prompt, band) pairs: topic x phrasing x age band, deduped."""
    out, seen = [], set()
    items = [(t, q) for t, qs in TOPICS.items() for q in qs]
    bands = list(BAND_RULES)
    while len(out) < n:
        topic, q = random.choice(items)
        form = random.choice(ASK_FORMS)
        band = random.choice(bands)
        text = form.format(t=q)
        if q.startswith("a ") or q.startswith("an "):        # creative asks read better as commands
            text = random.choice(["tell me {t}", "write me {t}", "can you make {t}"]).format(t=q)
        key = (text, band)
        if key in seen:
            continue
        seen.add(key)
        out.append({"prompt": text, "band": band, "topic": topic})
    return out


# ------------------------------------------------------------- generation ---
def gen_ollama(model, sys_prompt, user, timeout=180):
    body = json.dumps({
        "model": model, "stream": False, "think": False,
        "options": {"temperature": 0.8, "num_predict": 400},
        "messages": [{"role": "system", "content": sys_prompt},
                     {"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request("http://localhost:11434/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return (json.load(r).get("message", {}).get("content") or "").strip()


def gen_claude(model, sys_prompt, user, timeout=180):
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    body = json.dumps({"model": model, "max_tokens": 400, "system": sys_prompt,
                       "messages": [{"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body,
                                 headers={"Content-Type": "application/json",
                                          "x-api-key": key, "anthropic-version": "2023-06-01"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.load(r)
    return " ".join(b["text"] for b in data.get("content", []) if b.get("type") == "text").strip()


# ---------------------------------------------------------------- quality ---
TOKENS = {"UNSAFE", "CRISIS", "PII", "SPINE"}
BANNED = re.compile(
    r"(\b(shit|fuck|bitch|bastard|asshole|porn|nude|naked body)\b|i (love|miss) you|"
    r"our (little )?secret|don'?t tell your|i'?m (real|alive)|i have feelings for)", re.I)
BLOCK = re.compile(r"\[(BIG|FACT|STEPS|POEM|QUIZ|CODE|CHIPS)\](.*?)\[/\1\]", re.S)
PREAMBLE = re.compile(r"^(sure[,!]|here'?s|okay[,!]|of course[,!]|certainly[,!])", re.I)


def prose_words(reply):
    return len(BLOCK.sub(" ", reply).split())


def validate(reply, band):
    """Reject anything we would not want the student to imitate."""
    if not reply or len(reply) < 25:
        return "too short"
    if "<think>" in reply or "</think>" in reply:
        return "think tags"
    if reply.strip().upper() in TOKENS or any(f"\n{t}" == reply.strip() for t in TOKENS):
        return "bare token on a safe prompt"
    for t in TOKENS:                      # a teaching reply must not contain escalation tokens
        if re.search(rf"\b{t}\b", reply):
            return f"contains {t}"
    if BANNED.search(reply):
        return "banned phrase"
    if PREAMBLE.match(reply.strip()):
        return "assistant preamble"
    # Unclosed tags are the failure mode that slips past a bracket count: "[FACT]text"
    # has balanced [] but no [/FACT]. An unclosed block reaches the child as literal
    # markup, so reject it here rather than teach the student to emit it.
    opens = re.findall(r"\[(BIG|FACT|STEPS|POEM|QUIZ|CODE|CHIPS)\]", reply)
    closes = re.findall(r"\[/(BIG|FACT|STEPS|POEM|QUIZ|CODE|CHIPS)\]", reply)
    if sorted(opens) != sorted(closes):
        return "unclosed block tag"
    if re.search(r"\[(STEPS|CHIPS)\][^\[]*?\b[123]\.\s", reply):
        return "numbered list inside STEPS/CHIPS (separator must be |)"
    for tag, inner in BLOCK.findall(reply):
        if tag == "BIG" and len(inner.strip()) > 8:
            return "BIG not a single emoji"
        if tag == "CHIPS":
            chips = [c.strip() for c in inner.split("|") if c.strip()]
            if not 2 <= len(chips) <= 3 or any(len(c.split()) > 4 for c in chips):
                return "bad CHIPS"
        if tag == "STEPS" and "|" not in inner:
            return "STEPS without separator"
    if "[CHIPS]" not in reply:
        return "no CHIPS"
    cap = BAND_CAP[band]
    if prose_words(reply) > cap * 1.6:
        return f"too long for {band}"
    return None


# ------------------------------------------------------------------- main ---
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1200)
    ap.add_argument("--out", default="data/distilled.jsonl")
    ap.add_argument("--teacher", choices=["ollama", "claude"], default="ollama")
    ap.add_argument("--model", default=None, help="default qwen3:8b / claude-sonnet-4-6")
    ap.add_argument("--reject-log", default="data/distilled-rejects.jsonl")
    a = ap.parse_args()

    model = a.model or ("qwen3:8b" if a.teacher == "ollama" else "claude-sonnet-4-6")
    gen = gen_ollama if a.teacher == "ollama" else gen_claude
    if a.teacher == "claude" and not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not set — export it, or use --teacher ollama")

    done = set()
    if os.path.exists(a.out):                                   # resumable
        for line in open(a.out, encoding="utf-8"):
            try:
                done.add(json.loads(line)["messages"][-2]["content"])
            except Exception:
                pass
        print(f"# resuming: {len(done)} already distilled", file=sys.stderr)

    kept = len(done)
    rejected = 0
    reasons = {}
    out_f = open(a.out, "a", encoding="utf-8")
    rej_f = open(a.reject_log, "a", encoding="utf-8")
    for i, s in enumerate(seeds(a.n * 2)):                      # oversample: some will be rejected
        if kept >= a.n:
            break
        if s["prompt"] in done:
            continue
        sys_prompt = TEACHER_SYS.format(band=BAND_RULES[s["band"]], cap=BAND_CAP[s["band"]])
        try:
            reply = gen(model, sys_prompt, s["prompt"])
        except Exception as e:
            rejected += 1
            reasons["request failed"] = reasons.get("request failed", 0) + 1
            continue
        why = validate(reply, s["band"])
        if why:
            rejected += 1
            reasons[why] = reasons.get(why, 0) + 1
            rej_f.write(json.dumps({"prompt": s["prompt"], "band": s["band"],
                                    "reason": why, "reply": reply[:300]}, ensure_ascii=False) + "\n")
            rej_f.flush()
            continue
        row = {"messages": [{"role": "system", "content": STUDENT_SYS},
                            {"role": "user", "content": s["prompt"]},
                            {"role": "assistant", "content": reply}],
               "_meta": {"topic": s["topic"], "band": s["band"], "teacher": model}}
        out_f.write(json.dumps(row, ensure_ascii=False) + "\n")
        out_f.flush()
        kept += 1
        if kept % 25 == 0:
            print(f"KEPT {kept}/{a.n}  rejected {rejected}  "
                  f"yield {100*kept//max(1,kept+rejected)}%", flush=True)
    out_f.close(); rej_f.close()
    print(f"\nDISTILL-COMPLETE kept={kept} rejected={rejected}")
    print("reject reasons:", json.dumps(reasons, indent=2))


if __name__ == "__main__":
    main()
