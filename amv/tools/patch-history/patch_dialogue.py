#!/usr/bin/env python3
"""Attach dialogue to shots, and let the planner reason over picture + subtitle.

1. analyze --subs FILE : every shot gets the subtitle lines that overlap it.
2. the film map carries dialogue snippets next to the CLIP concepts.
3. story_spine(): one LLM call turns the map into a per-segment story summary,
   which the planner then uses to place each song section.
"""
P = "/home/taco/edit/edit.py"
s = open(P).read()

# ---------------------------------------------------------------- dialogue on shots
anchor = "def build_film_map("
fn = '''def attach_dialogue(shots, ass_path):
    """Give every shot the subtitle text spoken over it."""
    try:
        _, events = parse_ass(ass_path)
    except Exception as e:
        print(f"      字幕读取失败: {e}")
        return shots
    events = sorted(events, key=lambda x: x[0])
    for sh in shots:
        a, b = sh["start"], sh["end"]
        lines = []
        for (s0, s1, rest) in events:
            if s1 <= a or s0 >= b:
                continue
            txt = re.sub(r"\\{[^}]*\\}", "", rest.split(",", 6)[-1]).replace("\\\\N", " ").strip()
            if txt:
                lines.append(txt)
        sh["dialogue"] = " / ".join(lines[:3])[:200]
    got = sum(1 for x in shots if x.get("dialogue"))
    print(f"      台词挂载: {got}/{len(shots)} 个镜头有对白")
    return shots


'''
assert anchor in s
s = s.replace(anchor, fn + anchor, 1)

# ---------------------------------------------------------------- map with dialogue
old = '''        tags = [CONCEPTS[j] for j in top if Z[i][j] > 0.25] or [CONCEPTS[top[0]]]
        out.append({"t0": round(a / 60, 1), "t1": round(b / 60, 1), "tags": tags})'''
new = '''        tags = [CONCEPTS[j] for j in top if Z[i][j] > 0.25] or [CONCEPTS[top[0]]]
        # dialogue spoken in this bucket - a few representative lines
        said = []
        for sh in shots:
            if a <= sh["start"] < b and sh.get("dialogue"):
                said.extend(sh["dialogue"].split(" / "))
        said = [x for x in dict.fromkeys(said) if len(x) > 3][:3]
        out.append({"t0": round(a / 60, 1), "t1": round(b / 60, 1), "tags": tags,
                    "said": said})'''
assert old in s
s = s.replace(old, new, 1)

# ---------------------------------------------------------------- map renderer
old2 = '''def film_map_text(fmap, max_rows=60):
    """Compact, token-cheap rendering of the map for the prompt."""
    if not fmap:
        return "(no content map available)"
    step = max(1, len(fmap) // max_rows)
    parts = []
    for e in fmap[::step]:
        parts.append(f"{e['t0']:.0f}-{e['t1']:.0f}min: " + "/".join(e["tags"]))
    return "\\n".join(parts)'''
new2 = '''def film_map_text(fmap, max_rows=80):
    """Compact rendering: picture concepts plus what is said in each block."""
    if not fmap:
        return "(no content map available)"
    step = max(1, len(fmap) // max_rows)
    parts = []
    for e in fmap[::step]:
        line = f"{e['t0']:.0f}-{e['t1']:.0f}min: " + "/".join(e["tags"])
        said = e.get("said") or []
        if said:
            line += " | " + " ⏎ ".join(x[:40] for x in said)
        parts.append(line)
    return "\\n".join(parts)


def story_spine(fmap, backend="local", model=None, api_key=None, chunk_min=8):
    """One LLM call: summarise the film segment by segment into a story spine."""
    if not fmap:
        return []
    chunks = []
    cur = []
    for e in fmap:
        cur.append(e)
        if e["t1"] - cur[0]["t0"] >= chunk_min:
            chunks.append(cur); cur = []
    if cur:
        chunks.append(cur)
    lines = []
    for ch in chunks:
        tags = sorted({t for e in ch for t in e["tags"]} )
        said = [x for e in ch for x in (e.get("said") or [])][:6]
        lines.append(f"{ch[0]['t0']:.0f}-{ch[-1]['t1']:.0f}min  picture: "
                     + ", ".join(tags[:6]) + ("  said: " + " / ".join(said) if said else ""))
    prompt = ("Below is a feature film broken into blocks, each with visual concepts and a "
              "few subtitle lines. Summarise the STORY: one short line per block saying "
              "what happens, in order, using the subtitles to understand the meaning.\\n\\n"
              + "\\n".join(lines)
              + '\\n\\nReply with ONLY JSON: {"spine":[{"film":[start,end],"what":"..."}]}')
    try:
        raw = call_llm(prompt, backend, model, api_key)
        cand = parse_llm_json(raw)
        spine = (cand or {}).get("spine") or []
        if spine:
            save_json("story_spine.json", spine)
            print(f"      故事脉络: {len(spine)} 段")
        return spine
    except Exception as ex:
        print(f"      故事脉络生成失败 ({type(ex).__name__})")
        return []'''
assert old2 in s
s = s.replace(old2, new2, 1)

open(P, "w").write(s)
print("added dialogue attachment + story spine")
