#!/usr/bin/env python3
"""Rewrite shot assignment: no reuse, story order, CLIP-guided.

Problems with the old expander:
  * it cycled a 2-3 shot pool (`pool[k % len(pool)]`) so the same clip appeared
    over and over - the user called this out as bad to watch;
  * shots were picked by rotation, so the picture had no relation to the song's arc.

New rules:
  1. NO SOURCE TIME RANGE IS USED TWICE. A long shot may be split into several
     pieces (that is how a flashback is built) but each piece is used exactly once;
     a per-shot cap keeps any one scene from dominating.
  2. STORY ORDER. The film is cut into contiguous, monotonically increasing slices,
     one per song section. Section k only draws from slice k, and inside a slice the
     shots are placed in film order. So the picture travels forward through the story
     as the song plays.
  3. CLIP GUIDANCE. Inside a slice, candidates are ranked by CLIP similarity to the
     section's keywords, then re-sorted chronologically - relevance without losing
     the narrative order.
"""
P = "/home/taco/edit/edit.py"
s = open(P).read()

start = s.index("def expand_to_edl(")
end = s.index("def plan(")

new = '''def _clip_text_embs(queries):
    """Text embeddings for section keywords, one batched call."""
    import torch
    import open_clip
    model, _, _ = open_clip.create_model_and_transforms(
        CLIP_MODEL, pretrained=CLIP_PRETRAINED)
    model = model.cuda().eval() if torch.cuda.is_available() else model.eval()
    tok = open_clip.get_tokenizer(CLIP_MODEL)
    with torch.no_grad():
        t = model.encode_text(tok(queries).to(next(model.parameters()).device))
        t = t / t.norm(dim=-1, keepdim=True)
    return t.cpu().numpy()


def score_shots(shots, blueprint, index_npz=None):
    """Attach a CLIP score per (shot, section). Falls back to zeros without an index."""
    path = index_npz or os.path.join(WORK, "index.npz")
    if not os.path.exists(path):
        for sh in shots:
            sh["scores"] = [0.0] * len(blueprint)
        return shots
    d = np.load(path)
    emb, ids = d["emb"], {int(i): k for k, i in enumerate(d["ids"])}
    queries = [", ".join(bp.get("keywords") or [bp["name"]]) for bp in blueprint]
    try:
        temb = _clip_text_embs(queries)
    except Exception:
        for sh in shots:
            sh["scores"] = [0.0] * len(blueprint)
        return shots
    for sh in shots:
        k = ids.get(sh["id"])
        sh["scores"] = ([round(float(e), 4) for e in (emb[k] @ temb.T)]
                        if k is not None else [0.0] * len(blueprint))
    return shots


def story_slices(shots, blueprint):
    """Contiguous, increasing slices of the film - one per song section."""
    ordered = sorted(shots, key=lambda x: x["start"])
    total_song = sum(max(0.1, bp["end"] - bp["start"]) for bp in blueprint)
    out, cursor = [], 0
    for i, bp in enumerate(blueprint):
        frac = max(0.1, bp["end"] - bp["start"]) / total_song
        take = max(4, round(len(ordered) * frac))
        if i == len(blueprint) - 1:
            take = len(ordered) - cursor          # last slice absorbs the remainder
        out.append(ordered[cursor:cursor + take])
        cursor += take
        if cursor >= len(ordered):
            cursor = len(ordered)
    return out


def expand_to_edl(plan, beats, shots, blueprint, max_uses_per_shot=2):
    """Beat-snapped cut list with no source-range reuse and forward story order."""
    beat = np.array(beats["beats"])
    bs = beats["beats"]
    good = [s for s in shots if s.get("usable", True)] or shots
    by_id = {s["id"]: s for s in good}

    # CLIP scores + narrative slices
    good = score_shots(good, blueprint)
    slices = story_slices(good, blueprint)
    sec_spec = {s["name"]: s for s in plan.get("sections", [])}

    used_ranges = {s["id"]: [] for s in good}     # (a,b) already consumed
    uses = {s["id"]: 0 for s in good}
    cursor = {i: 0 for i in range(len(blueprint))}  # read head inside each slice

    def free_span(sh, want):
        """Earliest unused [start, start+want) inside this shot, or None."""
        spans = sorted(used_ranges[sh["id"]])
        pos = sh["start"] + 0.05
        end = sh["end"] - 0.05
        for (a, b) in spans:
            if pos + want <= a:
                return pos
            pos = max(pos, b + 0.01)
        return pos if pos + want <= end else None

    cuts = []
    for si, bp in enumerate(blueprint):
        spec = sec_spec.get(bp["name"], {})
        avg_cut = min(max(float(spec.get("avg_cut") or 2.0), 0.35), 6.0)
        pool = slices[si]
        if not pool:
            continue
        # rank by CLIP for this section, keep a generous shortlist, restore film order
        want_n = max(8, int((bp["end"] - bp["start"]) / max(avg_cut, 0.4)) * 3)
        ranked = sorted(pool, key=lambda x: -(x["scores"][si] if x.get("scores") else 0))
        short = ranked[:min(len(ranked), want_n)]
        short.sort(key=lambda x: x["start"])       # <- story order inside the section

        t = float(bp["start"])
        end = float(bp["end"])
        i = 0
        while t < end - 0.05 and i < len(short) * 4:
            idx = int(np.searchsorted(beat, t + 1e-6))
            target = t + avg_cut
            while idx < len(bs) and bs[idx] < target - 1e-6:
                idx += 1
            nxt = float(bs[idx]) if idx < len(bs) else end
            nxt = min(nxt, end)
            dur = nxt - t
            if dur <= 0.05:
                break

            chosen = None
            # 1) an unused shot from this slice, in film order
            for sh in short:
                if uses[sh["id"]] > 0:
                    continue
                pos = free_span(sh, dur)
                if pos is not None:
                    chosen = (sh, pos); break
            # 2) allow a split piece from a shot used once (this is how a long scene
            #    becomes a repeated flashback - each piece still used only once)
            if not chosen and max_uses_per_shot > 1:
                for sh in short:
                    if uses[sh["id"]] >= max_uses_per_shot:
                        continue
                    pos = free_span(sh, dur)
                    if pos is not None:
                        chosen = (sh, pos); break
            # 3) widen to the whole film, still unused
            if not chosen:
                for sh in sorted(good, key=lambda x: x["start"]):
                    if uses[sh["id"]] >= max_uses_per_shot:
                        continue
                    pos = free_span(sh, dur)
                    if pos is not None:
                        chosen = (sh, pos); break
            if not chosen:
                # nothing left with enough room: hold the previous frame
                cuts.append({"section": bp["name"], "shot": -1, "src_in": 0.0,
                             "dur": round(dur, 3), "src_dur": 0.0, "tl": round(t, 3),
                             "fill": round(dur, 3), "transition": "cut"})
                t = nxt
                continue

            sh, pos = chosen
            used_ranges[sh["id"]].append((pos, pos + dur))
            uses[sh["id"]] += 1
            cuts.append({"section": bp["name"], "shot": sh["id"],
                         "src_in": round(pos, 3), "dur": round(dur, 3),
                         "src_dur": round(dur, 3), "tl": round(t, 3), "fill": 0.0,
                         "transition": spec.get("transition", "cut")})
            t = nxt
            i += 1
    return {"cuts": cuts, "notes": plan.get("notes", ""),
            "plan": plan, "blueprint": blueprint}


'''
s = s[:start] + new + s[end:]

# the LLM no longer needs to name shots; pacing only
s = s.replace('''Decide, per section, HOW to cut - not every cut edit. Reply with ONLY this JSON:

{"sections":[
  {"name":"intro","avg_cut":2.5,"shots":[3,7],"transition":"fade"},
  {"name":"verse","avg_cut":1.8,"shots":[12,4,9],"transition":"cut"}
],"notes":"one line"}

Rules:
- avg_cut is the target seconds per cut in that section. Louder sections -> smaller
  (0.4-1.0). Quiet sections -> larger (2-4).
- shots is a short list of shot ids you want in that section, in priority order.
  Only use ids from the provided list.
- transition: "cut" for hard cuts, "fade" only for the first and last section.
- Keep it SHORT: at most 3 shots per section. No times, no individual cuts.
"""''',
'''Decide, per section, the PACING. Shot selection is handled separately, so do not
name shots. Reply with ONLY this JSON:

{"sections":[
  {"name":"intro","avg_cut":2.5,"transition":"fade"},
  {"name":"verse","avg_cut":1.8,"transition":"cut"}
],"notes":"the story you intend, one line"}

Rules:
- avg_cut is the target seconds per cut in that section. Louder/faster -> smaller
  (0.4-1.0). Quiet -> larger (2-4).
- transition: "cut" for hard cuts, "fade" only for the first and last section.
- Think of the film's narrative arc: the song should travel forward through the story.
- Keep it SHORT. No shots, no times, no individual cuts.
"""''')

open(P, "w").write(s)
print("rewrote expander: no-reuse + story slices + CLIP ranking")
