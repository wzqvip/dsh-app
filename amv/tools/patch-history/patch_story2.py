#!/usr/bin/env python3
"""Wire story beats into planning and expansion."""
P = "/home/taco/edit/edit.py"
s = open(P).read()

# ---- prompt: beats carry both the film range and the pacing
a = s.index('PLAN_SYSTEM = """')
b = s.index('def build_plan_payload(')
s = s[:a] + '''PLAN_SYSTEM = """You are a film editor planning a music video from a feature film.

You get: the song's sections (with energy and a cut budget), and a CONTENT MAP of the
film showing which concepts are unusually prominent in each minute. Decide the STORY
first: which part of the film each song section draws from.

Reply with ONLY this JSON:

{"beats":[
  {"section":"intro","film":[0,8],"avg_cut":3.5,"flashback":false,"intent":"the ruined world"},
  {"section":"chorus1","film":[40,50],"avg_cut":0.8,"flashback":false,"intent":"the war erupts"},
  {"section":"bridge","film":[8,14],"avg_cut":2.5,"flashback":true,"intent":"her quiet days, remembered"}
],"story":"two sentences on the arc you are building"}

Rules:
- `film` is a range in MINUTES of the source film, [start, end].
- `avg_cut` is the pacing for that section in seconds. High energy -> 0.5-1.0.
  Quiet -> 2.0-4.0.
- The MAIN PLOT must move FORWARD: a non-flashback section's range should start
  later than the previous non-flashback section's range.
- A flashback may jump back to an earlier range. Use at most two, and explain why
  in `intent`. Flashbacks are the only reason to go backwards.
- Match ranges to energy: loud sections -> ranges whose map tags are
  battle/explosion/fire/sword; quiet -> face/tears/snow/landscape/chess.
- Each range must be wide enough: roughly avg_cut * expected cuts, and at least 60 s.
"""


''' + s[b:]

# ---- plan(): build the film map, parse beats, keep the fallback honest
a = s.index("def plan(")
b = s.index("def default_blueprint(")
s = s[:a] + '''def plan(backend="local", model=None, api_key=None, blueprint=None):
    beats = load_json("beats.json")
    shots = load_json("shots.json")
    bp = blueprint or default_blueprint(beats["duration"])

    fmap = build_film_map(shots)
    if fmap:
        print(f"      内容地图 {len(fmap)} 个分桶")

    payload = build_plan_payload(beats, shots, bp, fmap)
    print(f"[plan] backend={backend}  prompt={len(payload)} 字符")

    story = None
    if backend != "none":
        for attempt in (1, 2):
            try:
                raw = call_llm(payload, backend, model, api_key) if attempt == 1 else \\
                    call_llm(payload + "\\n\\nONLY the JSON object. No prose.",
                             backend, model, api_key)
                cand = parse_llm_json(raw)
                if cand and cand.get("beats"):
                    story = cand
                    print(f"      剧情规划（第 {attempt} 次）成功")
                    break
                print(f"      第 {attempt} 次解析失败: {(raw or '')[:100]!r}")
            except Exception as ex:
                print(f"      LLM 第 {attempt} 次调用失败 "
                      f"({type(ex).__name__}: {str(ex)[:70]})")

    if story:
        edl = expand_beats(story, beats, shots, bp)
    else:
        coarse = fallback_plan(beats, shots, bp)
        print("      使用确定性兜底（按比例切片）")
        edl = expand_to_edl(coarse, beats, shots, bp)

    save_json("edl.json", edl)
    cuts = edl["cuts"]
    total = max((c["tl"] + c["dur"]) for c in cuts) if cuts else 0.0
    print(f"      {len(cuts)} 个切点  时间轴 {total:.1f}s  "
          f"({len(cuts)/max(total,0.01)*60:.1f} 切/分钟)")
    if edl.get("story"):
        print(f"      故事: {edl['story']}")
    for bb in (edl.get("beats") or []):
        n = sum(1 for c in cuts if c["section"] == bb["section"])
        fb = " [闪回]" if bb.get("flashback") else ""
        print(f"        {bb['section']:9s} 片源 {bb['film'][0]:.0f}-{bb['film'][1]:.0f} 分"
              f"  avg={bb.get('avg_cut')}  → {n} 刀{fb}")
    return edl


''' + s[b:]

open(P, "w").write(s)
print("wired story beats into plan()")
