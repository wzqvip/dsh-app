#!/usr/bin/env python3
"""Export shots + matched dialogue for an external (stronger) model to write the story.

Produces three files in ~/edit/export/:
  shots.json        full structured data, one object per shot
  timeline.md       compact, readable by a human or an LLM (minute by minute)
  README.txt        what the fields mean
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, "/home/taco/edit")
import edit as E

WORK = "/home/taco/edit"
OUT = os.path.join(WORK, "export")
os.makedirs(OUT, exist_ok=True)

shots = json.load(open(os.path.join(WORK, "shots.json")))
beats = json.load(open(os.path.join(WORK, "beats.json")))
film = beats.get("footage", "footage/ngnl_zero.mkv")

# ---- per-shot visual tags from the CLIP index
tags_by_shot = {}
idx_path = os.path.join(WORK, "index.npz")
if os.path.exists(idx_path) and os.path.exists(os.path.join(WORK, "film_map.json")):
    d = np.load(idx_path)
    emb = d["emb"]
    ids = {int(i): k for k, i in enumerate(d["ids"])}
    cemb = E._clip_text_embs(E.CONCEPTS)
    # same time normalisation that made the film map usable
    M = emb @ cemb.T
    mu, sd = M.mean(axis=0), M.std(axis=0) + 1e-6
    Z = (M - mu) / sd
    for sh in shots:
        k = ids.get(sh["id"])
        if k is None:
            continue
        order = np.argsort(-Z[k])[:3]
        tags_by_shot[sh["id"]] = [E.CONCEPTS[j] for j in order if Z[k][j] > 0.2] \
            or [E.CONCEPTS[order[0]]]

rows = []
for sh in shots:
    rows.append({
        "id": sh["id"],
        "t_start_s": round(sh["start"], 2),
        "t_end_s": round(sh["end"], 2),
        "dur_s": round(sh["dur"], 2),
        "t_start_min": round(sh["start"] / 60.0, 2),
        "dialogue": sh.get("dialogue") or None,
        "visual_tags": tags_by_shot.get(sh["id"], []),
        "luma": sh.get("luma"),
        "detail": sh.get("detail"),
        "usable": bool(sh.get("usable", True)),
    })

spine = []
sp = os.path.join(WORK, "story_spine.json")
if os.path.exists(sp):
    spine = json.load(open(sp))

doc = {
    "meta": {
        "film": os.path.basename(film),
        "film_duration_s": round(max(s["t_end_s"] for s in rows), 2),
        "shot_count": len(rows),
        "usable_count": sum(1 for s in rows if s["usable"]),
        "shots_with_dialogue": sum(1 for s in rows if s["dialogue"]),
        "source": "auto scene detection (PySceneDetect) + CLIP visual tags + subtitle alignment",
        "notes": [
            "One entry per detected shot, in film order.",
            "dialogue is the subtitle text spoken over that shot (may include several lines).",
            "visual_tags are CLIP concepts that are unusually strong for this shot "
            "relative to the rest of the film (time-normalised).",
            "usable=false means the shot is too dark / flat / short to cut with.",
        ],
    },
    "story_spine": spine,
    "shots": rows,
}
json.dump(doc, open(os.path.join(OUT, "shots.json"), "w"), ensure_ascii=False, indent=1)
print(f"wrote export/shots.json  ({os.path.getsize(os.path.join(OUT,'shots.json'))/1024:.0f} KB)")

# ---- compact timeline for an LLM with a smaller context
lines = [
    f"# {os.path.basename(film)} — shot timeline",
    f"{len(rows)} shots, {doc['meta']['usable_count']} usable, "
    f"{doc['meta']['shots_with_dialogue']} with dialogue",
    "",
    "Format: `id | start-end (min) | visual tags | dialogue`",
    "",
]
cur_min = -1
for r in rows:
    m = int(r["t_start_min"])
    if m != cur_min:
        lines.append(f"\n## minute {m}")
        cur_min = m
    tags = ",".join(r["visual_tags"]) or "-"
    dlg = r["dialogue"] or ""
    s0 = r["t_start_s"] / 60.0
    s1 = (r["t_start_s"] + r["dur_s"]) / 60.0
    lines.append(f"- {r['id']} | {s0:.2f}-{s1:.2f} | {tags} | {dlg}")
open(os.path.join(OUT, "timeline.md"), "w").write("\n".join(lines) + "\n")
print(f"wrote export/timeline.md  ({os.path.getsize(os.path.join(OUT,'timeline.md'))/1024:.0f} KB)")

readme = """shots.json fields
=================
meta                 film name, duration, counts, provenance
story_spine          optional: block summaries produced earlier (film minutes -> what happens)
shots[]              one entry per detected shot, in film order
  id                 shot id (stable, use this to reference a cut)
  t_start_s / t_end_s  position in the source film, seconds
  t_start_min        same, in minutes (handy for ranges)
  dur_s              shot length
  dialogue           subtitle text spoken over the shot, null if silent
  visual_tags        CLIP concepts that are unusually strong here (time-normalised
                     across the film, so they describe what distinguishes this shot)
  luma / detail      brightness and edge-energy; low values mean a dark or flat frame
  usable             false = too dark / flat / short to cut with

timeline.md          the same data as a compact minute-by-minute list, easier to
                     paste into a model with a smaller context window.

How to use it
-------------
Ask the model to choose, for each section of the song, a RANGE of film minutes,
and to keep the main plot moving forward (flashbacks allowed if declared).
Then the edit tool can take that plan and cut it.
"""
open(os.path.join(OUT, "README.txt"), "w").write(readme)
print("wrote export/README.txt")
