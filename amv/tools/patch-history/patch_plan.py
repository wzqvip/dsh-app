#!/usr/bin/env python3
"""Rework planning: the LLM picks STRUCTURE, code expands it onto the beat grid.

Asking a model for 200+ explicit cuts fails (it rambles and the JSON breaks).
Real auto-editors split it: the model decides "section X uses shots 12/45, cuts
every ~2 s, hard cuts" and the renderer derives exact beat-snapped cut points.
That is both reliable and better timed.
"""
P = "/home/taco/edit/edit.py"
s = open(P).read()

start = s.index("PLAN_SYSTEM = ")
end = s.index("# --------------------------------------------------------------------- render")

new = '''PLAN_SYSTEM = """You are a music-video editor planning a cut structure.

You get: the song timeline (bpm, downbeats, energy per second), section boundaries
with moods and keywords, and a list of available shots with durations.

Decide, per section, HOW to cut - not every cut edit. Reply with ONLY this JSON:

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
"""


def build_plan_payload(beats, shots, blueprint, budget_shots=200):
    dur = beats["duration"]
    n = len(shots)
    step = max(1, n // budget_shots)
    picked = shots[::step][:budget_shots]
    lines = [f"SONG {dur:.1f}s  {beats['tempo']} BPM"]
    down = beats["beats"][::4]
    lines.append("DOWNBEATS " + " ".join(f"{b:.2f}" for b in down[:100]))
    e = beats["energy_per_sec"]
    buckets = [round(float(np.mean(e[i:i + 8])), 3) for i in range(0, len(e), 8)]
    lines.append("ENERGY/8s " + " ".join(f"{v:.2f}" for v in buckets))
    lines.append("SECTIONS")
    for s in blueprint:
        lines.append(f"  {s['name']} {s['start']:.1f}-{s['end']:.1f} mood={s.get('mood','')} "
                     f"kw={','.join(s.get('keywords', []))}")
    lines.append(f"SHOTS n={n} (id:dur) " +
                 " ".join(f"{s['id']}:{s['dur']:.1f}" for s in picked))
    return "\\n".join(lines)


def call_llm(payload: str, backend: str, model: str | None = None,
             api_key: str | None = None) -> str:
    import urllib.request
    if backend == "deepseek":
        key = api_key or os.environ.get("DEEPSEEK_API_KEY")
        if not key:
            die("需要 DEEPSEEK_API_KEY（或 --api-key）")
        body = {"model": model or "deepseek-chat",
                "messages": [{"role": "system", "content": PLAN_SYSTEM},
                             {"role": "user", "content": payload}],
                "temperature": 0.2, "max_tokens": 1500,
                "response_format": {"type": "json_object"}}
        req = urllib.request.Request(
            "https://api.deepseek.com/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.load(r)["choices"][0]["message"]["content"]
    port = int(model) if model and model.isdigit() else 8888
    body = {"messages": [{"role": "system", "content": PLAN_SYSTEM},
                         {"role": "user", "content": payload}],
            "max_tokens": 1500, "temperature": 0.2}
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        msg = json.load(r)["choices"][0]["message"]
    return msg.get("content") or ""


def fallback_plan(beats, shots, blueprint):
    """Energy-driven structure, used when the LLM is unavailable or returns junk."""
    e = beats["energy_per_sec"]
    secs = []
    for s in blueprint:
        lo, hi = int(s["start"]), max(int(s["start"]) + 1, int(s["end"]))
        avg_e = float(np.mean(e[lo:hi])) if hi > lo else 0.05
        # louder -> shorter cuts
        avg_cut = float(np.clip(3.2 - avg_e * 22.0, 0.45, 3.5))
        secs.append({"name": s["name"], "avg_cut": round(avg_cut, 2),
                     "shots": [], "transition": "cut"})
    secs[0]["transition"] = "fade"
    secs[-1]["transition"] = "fade"
    return {"sections": secs, "notes": "deterministic fallback (no LLM)"}


def expand_to_edl(plan: dict, beats: dict, shots: list, blueprint: list) -> dict:
    """Turn the coarse section plan into an exact, beat-snapped cut list."""
    beat = np.array(beats["beats"])
    bs = beats["beats"]
    nshots = len(shots)
    all_ids = [s["id"] for s in shots]

    sec_by_name = {s["name"]: s for s in plan.get("sections", [])}
    cuts = []
    used_last = None
    for bp in blueprint:
        spec = sec_by_name.get(bp["name"], {})
        avg_cut = float(spec.get("avg_cut") or 2.0)
        avg_cut = min(max(avg_cut, 0.35), 6.0)
        pool = [i for i in (spec.get("shots") or []) if i in set(all_ids)]
        if not pool:
            pool = all_ids
        t = float(bp["start"])
        end = float(bp["end"])
        k = 0
        while t < end - 0.05:
            # next beat boundary at least avg_cut away
            nxt = float(np.searchsorted(beat, t + 1e-6))
            idx = int(nxt)
            target = t + avg_cut
            while idx < len(bs) and bs[idx] < target - 1e-6:
                idx += 1
            nxt_t = float(bs[idx]) if idx < len(bs) else end
            nxt_t = min(nxt_t, end)
            dur = nxt_t - t
            if dur <= 0.05:
                break
            sid = pool[k % len(pool)]
            k += 1
            if sid == used_last and len(pool) > 1:
                sid = pool[k % len(pool)]
                k += 1
            used_last = sid
            sh = shots[sid]
            # never request more source than the shot has
            src_dur = min(dur, max(0.2, sh["dur"] - 0.05))
            src_in = sh["start"] + max(0.0, (sh["dur"] - src_dur) * 0.25)
            cuts.append({"section": bp["name"], "shot": sid,
                         "src_in": round(src_in, 3), "dur": round(src_dur, 3),
                         "tl": round(t, 3),
                         "fill": round(max(0.0, dur - src_dur), 3),
                         "transition": spec.get("transition", "cut")})
            t = nxt_t
    return {"cuts": cuts, "notes": plan.get("notes", ""),
            "plan": plan, "blueprint": blueprint}


def plan(backend="local", model=None, api_key=None, blueprint=None):
    beats = load_json("beats.json")
    shots = load_json("shots.json")
    bp = blueprint or default_blueprint(beats["duration"])
    payload = build_plan_payload(beats, shots, bp)
    print(f"[plan] backend={backend}  prompt={len(payload)} 字符")
    coarse = None
    if backend != "none":
        try:
            raw = call_llm(payload, backend, model, api_key)
            m = re.search(r"\\{.*\\}", raw, re.S)
            if m:
                cand = json.loads(m.group(0))
                if cand.get("sections"):
                    coarse = cand
                    print("      LLM 返回了结构计划")
        except Exception as ex:
            print(f"      LLM 失败 ({type(ex).__name__}: {str(ex)[:80]})")
    if not coarse:
        coarse = fallback_plan(beats, shots, bp)
        print("      使用确定性兜底计划")
    edl = expand_to_edl(coarse, beats, shots, bp)
    save_json("edl.json", edl)
    cuts = edl["cuts"]
    total = sum(c["dur"] for c in cuts)
    print(f"      {len(cuts)} 个切点  覆盖 {total:.1f}s  "
          f"({len(cuts)/max(total,0.01)*60:.1f} 切/分钟)")
    for s in coarse.get("sections", []):
        ns = sum(1 for c in cuts if c["section"] == s["name"])
        print(f"        {s['name']:9s} avg_cut={s.get('avg_cut')}  → {ns} 个切点")
    return edl


'''
s = s[:start] + new + s[end:]

# cli: allow --backend none
s = s.replace('p.add_argument("--backend", default="local", choices=["local", "deepseek"])',
              'p.add_argument("--backend", default="local", choices=["local", "deepseek", "none"])')
s = s.replace('run.add_argument("--backend", default="local")',
              'run.add_argument("--backend", default="local")')

open(P, "w").write(s)
print("rewrote planning")
