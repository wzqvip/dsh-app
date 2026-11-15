#!/usr/bin/env python3
"""Two-stage editing: plan the story first, then cut.

The user's requirement: the main plot should move forward in time, but a flashback
is allowed to jump back on purpose. So chronology stops being a hard mechanical rule
and becomes a narrative decision - which means the model needs to know WHAT is where
in the film.

New stage 1: build a content map of the film (CLIP concept probes aggregated into
time buckets), show it to the LLM, and have it assign each song section a FILM RANGE
plus a flashback flag. Stage 2 expands that into beat-snapped cuts.
"""
P = "/home/taco/edit/edit.py"
s = open(P).read()

# ------------------------------------------------------------------ concepts + map
anchor = "def _clip_text_embs(queries):"
concepts = '''# Concept probes for the film content map. English because CLIP was trained on it.
CONCEPTS = [
    "battle", "explosion", "fire", "smoke", "sword fight", "dragon", "magic",
    "bright light", "night sky", "clouds", "ruins", "city", "forest", "snow",
    "rain", "sunset", "chess board", "hand", "face", "crying", "tears", "smile",
    "hug", "blood", "death", "white void", "stars", "ocean", "crowd of people",
    "empty landscape",
]


def build_film_map(shots, index_npz=None, bucket_s=60.0):
    """Aggregate CLIP concept scores into per-bucket tags -> what is where in the film."""
    path = index_npz or os.path.join(WORK, "index.npz")
    if not os.path.exists(path):
        return []
    d = np.load(path)
    emb, ids = d["emb"], {int(i): k for k, i in enumerate(d["ids"])}
    try:
        cemb = _clip_text_embs(CONCEPTS)
    except Exception:
        return []
    # shot -> concept scores
    rows = []
    for sh in shots:
        k = ids.get(sh["id"])
        if k is None:
            continue
        rows.append((sh["start"], sh["end"], emb[k] @ cemb.T))
    if not rows:
        return []
    total = max(r[1] for r in rows)
    out = []
    t = 0.0
    while t < total:
        seg = [r for r in rows if r[0] >= t and r[0] < t + bucket_s]
        if seg:
            mean = np.mean([r[2] for r in seg], axis=0)
            top = np.argsort(-mean)[:3]
            out.append({"t0": round(t / 60, 1), "t1": round(min(t + bucket_s, total) / 60, 1),
                        "tags": [CONCEPTS[i] for i in top],
                        "n": len(seg)})
        t += bucket_s
    save_json("film_map.json", out)
    return out


def film_map_text(fmap, max_rows=60):
    """Compact, token-cheap rendering of the map for the prompt."""
    if not fmap:
        return "(no content map available)"
    step = max(1, len(fmap) // max_rows)
    parts = []
    for e in fmap[::step]:
        parts.append(f"{e['t0']:.0f}-{e['t1']:.0f}min: " + "/".join(e["tags"]))
    return "\\n".join(parts)


'''
assert anchor in s
s = s.replace(anchor, concepts + anchor, 1)

# ------------------------------------------------------------------ new prompt
old_prompt_start = s.index('PLAN_SYSTEM = """')
old_prompt_end = s.index('def build_plan_payload(')
new_prompt = '''PLAN_SYSTEM = """You are a film editor planning a music video from a feature film.

You get: the song's sections (with energy), and a CONTENT MAP of the film showing
which concepts appear in each minute. Decide the STORY: which part of the film each
song section draws from.

Reply with ONLY this JSON:

{"beats":[
  {"section":"intro","film":[0,8],"flashback":false,"intent":"the ruined world"},
  {"section":"chorus1","film":[40,50],"flashback":false,"intent":"the war erupts"},
  {"section":"bridge","film":[8,14],"flashback":true,"intent":"her quiet days, remembered"}
],"story":"two sentences on the arc you are building"}

Rules:
- `film` is a range in MINUTES of the source film, [start, end].
- The MAIN PLOT must move FORWARD: for sections that are not flashbacks, `film`
  should start later than the previous non-flashback section's range.
- A flashback is allowed to jump back to an earlier range - use it deliberately,
  at most two, and say why in `intent`.
- Match the range to the section's energy: high energy -> pick ranges whose map tags
  are battle/explosion/fire; quiet sections -> face/tears/snow/landscape.
- Ranges must not overlap each other unless you set flashback=true.
- Keep each range wide enough for that section's number of cuts (>= 30 s per cut).
"""


'''
s = s[:old_prompt_start] + new_prompt + s[old_prompt_end:]

# ------------------------------------------------------------------ payload with map
old_payload_start = s.index('def build_plan_payload(')
old_payload_end = s.index('def call_llm(')
new_payload = '''def build_plan_payload(beats, shots, blueprint, fmap=None, budget_shots=200):
    usable = [x for x in shots if x.get("usable", True)]
    dur = beats["duration"]
    lines = [f"SONG {dur:.1f}s  {beats['tempo']} BPM"]
    e = beats["energy_per_sec"]
    buckets = [round(float(np.mean(e[i:i + 8])), 3) for i in range(0, len(e), 8)]
    lines.append("ENERGY/8s " + " ".join(f"{v:.2f}" for v in buckets))
    lines.append("SECTIONS")
    for b in blueprint:
        lo, hi = int(b["start"]), max(int(b["start"]) + 1, int(b["end"]))
        avg = float(np.mean(e[lo:hi])) if hi > lo else 0.05
        cuts = max(1, int((b["end"] - b["start"]) / 2.0))
        lines.append(f"  {b['name']} {b['start']:.0f}-{b['end']:.0f}s "
                     f"energy={avg:.3f} ~{cuts} cuts mood={b.get('mood','')}")
    lines.append("FILM CONTENT MAP (minutes -> concepts)")
    lines.append(film_map_text(fmap))
    lines.append(f"Film length ~{max((x['end'] for x in shots), default=0) / 60:.0f} min")
    return "\\n".join(lines)


'''
s = s[:old_payload_start] + new_payload + s[old_payload_end:]

open(P, "w").write(s)
print("added film map + story-beat prompt")
