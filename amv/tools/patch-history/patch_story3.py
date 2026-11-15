#!/usr/bin/env python3
"""expand_beats: turn story beats (film ranges) into a beat-snapped cut list."""
P = "/home/taco/edit/edit.py"
s = open(P).read()

anchor = "# --------------------------------------------------------------------- render"
fn = '''def expand_beats(story, beats, shots, blueprint, max_uses_per_shot=1):
    """Realise story beats: each section draws from ITS film range, no reuse.

    Sections are laid down in SONG order; a beat marked flashback simply points at an
    earlier film range, which is the one sanctioned way the picture goes backwards.
    """
    beat_arr = np.array(beats["beats"])
    bs = beats["beats"]
    good = [x for x in shots if x.get("usable", True)] or shots
    by_id = {x["id"]: x for x in good}

    beat_by_name = {b["section"]: b for b in story.get("beats", [])}
    used_ranges = {x["id"]: [] for x in good}
    uses = {x["id"]: 0 for x in good}

    def free_span(sh, want):
        pos = sh["start"] + 0.05
        end = sh["end"] - 0.05
        for (a, b) in sorted(used_ranges[sh["id"]]):
            if pos + want <= a:
                return pos
            pos = max(pos, b + 0.01)
        return pos if pos + want <= end else None

    cuts = []
    for bp in blueprint:
        spec = beat_by_name.get(bp["name"])
        if not spec:
            continue
        fm = spec.get("film") or [0, 0]
        f0, f1 = float(fm[0]) * 60.0, float(fm[1]) * 60.0
        if f1 <= f0:
            f1 = f0 + 60.0
        avg_cut = min(max(float(spec.get("avg_cut") or 2.0), 0.35), 6.0)
        pool = [x for x in good if f0 <= x["start"] < f1]
        if not pool:
            pool = sorted(good, key=lambda x: abs(x["start"] - f0))[:40]

        # CLIP rank inside the range, then spread evenly so one scene doesn't fill it
        sec_i = next((k for k, b in enumerate(blueprint) if b["name"] == bp["name"]), 0)
        ranked = sorted(pool, key=lambda x: -((x.get("scores") or [0])[sec_i]))
        short = sorted(ranked[:max(8, len(ranked))], key=lambda x: x["start"])
        need = int((bp["end"] - bp["start"]) / max(avg_cut, 0.4)) + 6
        if len(short) > need > 0:
            step = len(short) / float(need)
            seen, spread = set(), []
            for i in range(need):
                x = short[min(len(short) - 1, int(i * step))]
                if x["id"] not in seen:
                    seen.add(x["id"]); spread.append(x)
            short = spread

        t = float(bp["start"])
        end = float(bp["end"])
        guard = 0
        while t < end - 0.05 and guard < len(short) * 5 + 40:
            guard += 1
            idx = int(np.searchsorted(beat_arr, t + 1e-6))
            target = t + avg_cut
            while idx < len(bs) and bs[idx] < target - 1e-6:
                idx += 1
            nxt = min(float(bs[idx]) if idx < len(bs) else end, end)
            dur = nxt - t
            if dur <= 0.05:
                break

            chosen = None
            for sh in short:
                if uses[sh["id"]] >= max_uses_per_shot:
                    continue
                pos = free_span(sh, dur)
                if pos is not None:
                    chosen = (sh, pos, dur); break
            if not chosen:
                for sh in short:
                    if uses[sh["id"]] >= max_uses_per_shot:
                        continue
                    for frac in (0.7, 0.5, 0.35):
                        pos = free_span(sh, dur * frac)
                        if pos is not None:
                            chosen = (sh, pos, round(dur * frac, 3)); break
                    if chosen:
                        break
            if not chosen:
                cuts.append({"section": bp["name"], "shot": -1, "src_in": 0.0,
                             "dur": round(dur, 3), "src_dur": 0.0, "tl": round(t, 3),
                             "fill": round(dur, 3), "_film": f0,
                             "transition": "cut"})
                t = nxt
                continue

            sh, pos, sd = chosen
            used_ranges[sh["id"]].append((pos, pos + sd))
            uses[sh["id"]] += 1
            cuts.append({"section": bp["name"], "shot": sh["id"],
                         "src_in": round(pos, 3), "dur": round(dur, 3),
                         "src_dur": round(sd, 3), "tl": round(t, 3),
                         "fill": round(max(0.0, dur - sd), 3), "_film": sh["start"],
                         "transition": "cut"})
            t = nxt

    return {"cuts": cuts, "story": story.get("story", ""),
            "beats": story.get("beats", []), "blueprint": blueprint}


'''
assert anchor in s
s = s.replace(anchor, fn + anchor, 1)
open(P, "w").write(s)
print("added expand_beats")
