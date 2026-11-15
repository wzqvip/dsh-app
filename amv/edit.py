#!/usr/bin/env python3
"""edit — 全自动 AI 剪辑流水线（分析 → 规划 → 渲染）

设计目标：给定「一段视频素材 + 一首歌 + 剪辑蓝图」，全自动产出一个卡点的成片，
中间不需要任何剪辑软件。

    ./edit analyze  <footage> <song>            # 节拍 + 镜头切分 + CLIP 索引
    ./edit search   <query>                     # 自然语言找镜头
    ./edit plan     [--backend local|deepseek]  # LLM 出剪接表 (EDL)
    ./edit render                               # ffmpeg 出片
    ./edit run      <footage> <song>            # 一条龙

产物都在工作目录：beats.json / shots.json / index.npz / edl.json / out.mp4
"""
from __future__ import annotations

import argparse
import json
import os
import re
import hashlib
import shutil
import subprocess
import sys
import time

import numpy as np

# 中间产物统一放 ~/edit/work，源码和素材分开
WORK = os.environ.get("EDIT_WORK", os.path.expanduser("~/edit/work"))
os.makedirs(WORK, exist_ok=True)
CLIP_MODEL = "ViT-B-32"
CLIP_PRETRAINED = "laion2b_s34b_b79k"


# --------------------------------------------------------------------- helpers
def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def probe_duration(path: str) -> float:
    r = sh(["ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "csv=p=0", path])
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def probe_size(path: str):
    r = sh(["ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate",
            "-of", "csv=p=0:nk=1", path])
    try:
        w, h, fps = r.stdout.strip().split("\n")[0].split(",")
        num, _, den = fps.partition("/")
        return int(w), int(h), float(num) / float(den or 1)
    except Exception:
        return 1920, 1080, 24.0


def load_json(name, default=None):
    p = os.path.join(WORK, name)
    if not os.path.exists(p):
        if default is not None:
            return default
        die(f"{name} 不存在，先跑 analyze")
    return json.load(open(p))


def save_json(name, obj):
    p = os.path.join(WORK, name)
    json.dump(obj, open(p, "w"), ensure_ascii=False, indent=1)
    return p


# --------------------------------------------------------------------- analyze
def analyze(footage: str, song: str, max_shots: int = 4000, skip_clip: bool = False,
            detect_source: str | None = None, subs: str | None = None):
    """``footage`` is what gets RENDERED; ``detect_source`` is a fast proxy used for
    scene detection and CLIP frames. Timestamps match because both share fps and
    duration, so analysing a 360p proxy of a 106-minute film takes minutes, not an hour.
    """
    os.makedirs(WORK, exist_ok=True)
    t_all = time.time()
    detect_on = detect_source or footage

    # ---- audio: beats + energy sections
    import librosa
    print(f"[1/3] 分析音频 {song}")
    y, sr = librosa.load(song, sr=22050, mono=True)
    duration = len(y) / sr
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    tempo = float(np.atleast_1d(tempo)[0])
    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    ftimes = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    # 1 秒粒度的能量，用于给 LLM 判断段落强弱
    energy = []
    for sec in range(int(duration)):
        m = (ftimes >= sec) & (ftimes < sec + 1)
        energy.append(round(float(rms[m].mean()), 5) if m.any() else 0.0)
    save_json("beats.json", {"song": song, "footage": footage,
                             "detect_source": detect_on,
                             "duration": round(duration, 3),
                             "tempo": round(tempo, 2),
                             "beats": [round(float(b), 4) for b in beats],
                             "energy_per_sec": energy})
    print(f"      {duration:.1f}s  {tempo:.1f} BPM  {len(beats)} 拍")

    # ---- video: shots
    print(f"[2/3] 切分镜头 {detect_on}" + (f"（代理，渲染用 {footage}）"
                                          if detect_on != footage else ""))
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector
    video = open_video(detect_on)
    sm = SceneManager()
    sm.add_detector(ContentDetector(threshold=27.0, min_scene_len=12))
    sm.detect_scenes(video, show_progress=False)
    scenes = sm.get_scene_list()
    if not scenes:
        die("没有检测到镜头")
    shots = []
    for i, (s, e) in enumerate(scenes[:max_shots]):
        a = getattr(s, "seconds", None) or s.get_seconds()
        b = getattr(e, "seconds", None) or e.get_seconds()
        shots.append({"id": i, "start": round(a, 3), "end": round(b, 3),
                      "dur": round(b - a, 3)})
    save_json("shots.json", shots)
    print(f"      {len(shots)} 个镜头  平均 {np.mean([s['dur'] for s in shots]):.2f}s")

    # ---- CLIP index (one middle frame per shot)
    if skip_clip:
        print("[3/3] 跳过 CLIP 索引")
        return
    print(f"[3/3] CLIP 索引（每镜头取中间帧）")
    import cv2
    import torch
    import open_clip
    from PIL import Image
    model, _, preprocess = open_clip.create_model_and_transforms(
        CLIP_MODEL, pretrained=CLIP_PRETRAINED)
    model = model.cuda().eval() if torch.cuda.is_available() else model.eval()
    cap = cv2.VideoCapture(detect_on)
    if not cap.isOpened():
        die(f"打不开 {detect_on}")
    embs = []
    t0 = time.time()
    usable = []
    with torch.no_grad():
        for row in shots:
            mid = (row["start"] + row["end"]) / 2.0
            cap.set(cv2.CAP_PROP_POS_MSEC, mid * 1000.0)
            ok, frame = cap.read()
            if not ok:
                embs.append(np.zeros(512, dtype=np.float32))
                row["luma"] = 0.0
                row["detail"] = 0.0
                continue
            # quality metrics: a black or flat shot is useless to an editor
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            row["luma"] = round(float(gray.mean()), 2)
            row["detail"] = round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 2)
            usable.append(row["luma"] >= 12.0 and row["detail"] >= 6.0
                          and row["dur"] >= 0.35)
            pil = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            img = preprocess(pil)
            v = model.encode_image(img.unsqueeze(0).to(next(model.parameters()).device))
            v = v / v.norm(dim=-1, keepdim=True)
            embs.append(v.cpu().numpy()[0].astype(np.float32))
    cap.release()
    np.savez_compressed(os.path.join(WORK, "index.npz"),
                        emb=np.stack(embs),
                        ids=np.array([s["id"] for s in shots]))
    for row, ok in zip(shots, usable):
        row["usable"] = bool(ok)
    save_json("shots.json", shots)
    good = [s for s in shots if s.get("usable", True)]
    if subs:
        shots = attach_dialogue(shots, subs)
        save_json("shots.json", shots)
        good = [x for x in shots if x.get("usable", True)]
    print(f"      可用镜头 {len(good)}/{len(shots)}"
          f"（剔除黑帧/无细节/过短）")
    if not good:
        print("      警告: 没有可用镜头，放宽筛选")
        for row in shots:
            row["usable"] = True
        save_json("shots.json", shots)
    print(f"      {len(embs)} 帧，用时 {time.time()-t0:.1f}s（{len(embs)/(time.time()-t0):.0f} 帧/s）")
    print(f"\n完成，总用时 {time.time()-t_all:.1f}s")


# --------------------------------------------------------------------- search
def _clip_encode_text(query: str) -> np.ndarray:
    import torch
    import open_clip
    model, _, _ = open_clip.create_model_and_transforms(CLIP_MODEL, pretrained=CLIP_PRETRAINED)
    model = model.cuda().eval() if torch.cuda.is_available() else model.eval()
    tok = open_clip.get_tokenizer(CLIP_MODEL)
    with torch.no_grad():
        t = model.encode_text(tok([query]).to(next(model.parameters()).device))
        t = t / t.norm(dim=-1, keepdim=True)
    return t.cpu().numpy()[0]


def search(query: str, top: int = 10):
    d = np.load(os.path.join(WORK, "index.npz"))
    emb, ids = d["emb"], d["ids"]
    q = _clip_encode_text(query)
    sims = emb @ q
    order = np.argsort(-sims)[:top]
    shots = {s["id"]: s for s in load_json("shots.json")}
    out = []
    for i in order:
        sid = int(ids[i])
        s = shots[sid]
        out.append({"id": sid, "sim": round(float(sims[i]), 4),
                    "start": s["start"], "dur": s["dur"]})
        print(f"  shot #{sid:5d}  sim={sims[i]:.3f}  {s['start']:8.2f}s  {s['dur']:.2f}s")
    save_json(f"search_{re.sub(r'[^a-z0-9]+','_',query.lower())[:40]}.json", out)
    return out


# --------------------------------------------------------------------- plan
PLAN_SYSTEM = """You are a film editor planning a music video from a feature film.

You get: the song's sections (with energy and a cut budget), a STORY SPINE summarising
what happens in each part of the film (derived from picture plus subtitles), and a
CONTENT MAP of concepts per minute. Decide the STORY: which part of the film each song
section draws from, so the lyrics and the picture tell the same story.

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
- The MAIN PLOT must move FORWARD and COVER THE FILM: non-flashback ranges must be
  strictly increasing, the first must start near minute 0, the last must end near the
  end of the film, and no two consecutive non-flashback ranges may be more than
  ~15 minutes apart. A music video that covers the whole story is the goal; do not
  jump from minute 5 to minute 75 just because the tags match.
- A flashback may jump back to an earlier range. Use at most two, and explain why
  in `intent`. Flashbacks are the only reason to go backwards.
- Match ranges to energy: loud sections -> ranges whose map tags are
  battle/explosion/fire/sword; quiet -> face/tears/snow/landscape/chess.
- Each range must be wide enough: roughly avg_cut * expected cuts, and at least 60 s.
"""


def build_plan_payload(beats, shots, blueprint, fmap=None, spine=None, budget_shots=200):
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
    if spine:
        lines.append("STORY SPINE (what actually happens, from picture + subtitles)")
        for e in spine:
            lines.append(f"  {e.get('film',[0,0])[0]:.0f}-{e.get('film',[0,0])[1]:.0f}min: "
                         f"{e.get('what','')}")
    lines.append("FILM CONTENT MAP (minutes -> concepts | dialogue)")
    lines.append(film_map_text(fmap))
    lines.append(f"Film length ~{max((x['end'] for x in shots), default=0) / 60:.0f} min")
    return "\n".join(lines)


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
    # this is a reasoning model: without disabling thinking it burns the token budget
    # on prose and the JSON gets truncated mid-object
    body = {"messages": [{"role": "system", "content": PLAN_SYSTEM},
                         {"role": "user", "content": payload}],
            "max_tokens": 4000, "temperature": 0.2,
            "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        ch = json.load(r)["choices"][0]
    msg = ch["message"]
    out = msg.get("content") or ""
    if ch.get("finish_reason") == "length" and out.strip().endswith(("}", "]")):
        pass
    elif ch.get("finish_reason") == "length":
        print("      警告: 响应被截断 (finish_reason=length)")
    return out


def parse_llm_json(raw: str):
    """LLMs emit near-JSON: stray prose, trailing commas, single quotes, truncation,
    a missing closing bracket. Repair the common cases before giving up."""
    if not raw:
        return None
    i = raw.find("{")
    if i < 0:
        return None
    body = raw[i:]

    def attempt(txt):
        try:
            return json.loads(txt)
        except Exception:
            return None

    cand = attempt(body)
    if cand is not None:
        return cand
    cleaned = re.sub(r",\s*([}\]])", r"\1", body)
    cand = attempt(cleaned)
    if cand is not None:
        return cand
    cand = attempt(cleaned.replace("'", '"'))
    if cand is not None:
        return cand

    # Last resort: walk the text, tracking brackets OUTSIDE string literals, then
    # close in the correct order. Appending closers at the end is wrong when the
    # text already ends with "}" - the missing "]" has to go before it.
    stack, in_str, esc = [], False, False
    for ch in cleaned:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
    if in_str:
        cleaned += '"'
    while stack:
        cleaned += "]" if stack.pop() == "[" else "}"
    return attempt(cleaned)


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


# Concept probes for the film content map. English because CLIP was trained on it.
CONCEPTS = [
    "battle", "explosion", "fire", "smoke", "sword fight", "dragon", "magic",
    "bright light", "night sky", "clouds", "ruins", "city", "forest", "snow",
    "rain", "sunset", "chess board", "hand", "face", "crying", "tears", "smile",
    "hug", "blood", "death", "white void", "stars", "ocean", "crowd of people",
    "empty landscape",
]


def attach_dialogue(shots, ass_path):
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
            txt = re.sub(r"\{[^}]*\}", "", rest.split(",", 6)[-1]).replace("\\N", " ").strip()
            if txt:
                lines.append(txt)
        sh["dialogue"] = " / ".join(lines[:3])[:200]
    got = sum(1 for x in shots if x.get("dialogue"))
    print(f"      台词挂载: {got}/{len(shots)} 个镜头有对白")
    return shots


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
    raw, spans = [], []
    t = 0.0
    while t < total:
        seg = [r for r in rows if r[0] >= t and r[0] < t + bucket_s]
        if seg:
            raw.append(np.mean([r[2] for r in seg], axis=0))
            spans.append((t, min(t + bucket_s, total)))
        t += bucket_s
    if not raw:
        return []
    # Raw CLIP similarities have a per-concept baseline: some words score high on
    # almost every anime frame, so the plain average labels the whole film
    # "hand/battle/smoke". Normalise each concept ACROSS TIME and keep the peaks,
    # which is what actually distinguishes one minute of the film from another.
    M = np.stack(raw)                                   # (buckets, concepts)
    mu, sd = M.mean(axis=0), M.std(axis=0) + 1e-6
    Z = (M - mu) / sd
    out = []
    for i, (a, b) in enumerate(spans):
        top = np.argsort(-Z[i])[:3]
        # only keep concepts that are genuinely above this film's own average
        tags = [CONCEPTS[j] for j in top if Z[i][j] > 0.25] or [CONCEPTS[top[0]]]
        # dialogue spoken in this bucket - a few representative lines
        said = []
        for sh in shots:
            if a <= sh["start"] < b and sh.get("dialogue"):
                said.extend(sh["dialogue"].split(" / "))
        said = [x for x in dict.fromkeys(said) if len(x) > 3][:3]
        out.append({"t0": round(a / 60, 1), "t1": round(b / 60, 1), "tags": tags,
                    "said": said})
    save_json("film_map.json", out)
    return out


def film_map_text(fmap, max_rows=80):
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
    return "\n".join(parts)


def story_spine(fmap, backend="local", model=None, api_key=None, chunk_min=15):
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
              "few subtitle lines. Summarise the STORY: one line per block saying what "
              "happens, in order, using the subtitles to understand the meaning. "
              "AT MOST 12 WORDS PER BLOCK - brevity matters, the JSON must stay short.\n\n"
              + "\n".join(lines)
              + '\n\nReply with ONLY JSON, nothing else: '
                '{"spine":[{"film":[0,15],"what":"<=12 words"}]}')
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
        return []


def _clip_text_embs(queries):
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
        # rank by CLIP, keep a generous shortlist, restore film order, then SPREAD:
        # consecutive shots from the same scene look repetitive, so take evenly
        # spaced picks across the slice instead of reading it front to back.
        want_n = max(8, int((bp["end"] - bp["start"]) / max(avg_cut, 0.4)) * 3)
        ranked = sorted(pool, key=lambda x: -(x["scores"][si] if x.get("scores") else 0))
        short = sorted(ranked[:min(len(ranked), want_n)], key=lambda x: x["start"])
        need = int((bp["end"] - bp["start"]) / max(avg_cut, 0.4)) + 4
        if len(short) > need > 0:
            step = len(short) / float(need)
            picked = [short[min(len(short) - 1, int(i * step))] for i in range(need)]
            seen, spread = set(), []
            for x in picked:                      # dedupe, keep film order
                if x["id"] not in seen:
                    seen.add(x["id"]); spread.append(x)
            short = spread

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
            # 1) an unused shot from this slice, in film order. If none has room for
            # the whole cut, take a shorter piece and hold the last frame - that keeps
            # the story moving forward instead of jumping back to fill the slot.
            for sh in short:
                if uses[sh["id"]] > 0:
                    continue
                pos = free_span(sh, dur)
                if pos is not None:
                    chosen = (sh, pos, dur); break
            if not chosen:
                for sh in short:
                    if uses[sh["id"]] > 0:
                        continue
                    for frac in (0.75, 0.6, 0.45, 0.3):
                        pos = free_span(sh, dur * frac)
                        if pos is not None:
                            chosen = (sh, pos, round(dur * frac, 3)); break
                    if chosen:
                        break
            # 2) allow a split piece from a shot used once (this is how a long scene
            #    becomes a repeated flashback - each piece still used only once)
            if not chosen and max_uses_per_shot > 1:
                for sh in short:
                    if uses[sh["id"]] >= max_uses_per_shot:
                        continue
                    pos = free_span(sh, dur)
                    if pos is not None:
                        chosen = (sh, pos, dur); break
            # 3) widen to the whole film - but stay FORWARD in the story: prefer
            # shots later than whatever we last used, so a fallback never rewinds
            if not chosen:
                last_t = max((x.get("_film", -1.0) for x in cuts), default=-1.0)
                fwd = [x for x in good
                       if x["start"] >= last_t and uses[x["id"]] < max_uses_per_shot]
                bwd = [x for x in good
                       if x["start"] < last_t and uses[x["id"]] < max_uses_per_shot]
                for sh in sorted(fwd, key=lambda x: x["start"]) + sorted(bwd, key=lambda x: x["start"]):
                    pos = free_span(sh, dur)
                    if pos is not None:
                        chosen = (sh, pos, dur); break
            if not chosen:
                # nothing left with enough room: hold the previous frame
                cuts.append({"section": bp["name"], "shot": -1, "src_in": 0.0,
                             "dur": round(dur, 3), "src_dur": 0.0, "tl": round(t, 3),
                             "fill": round(dur, 3), "transition": "cut"})
                t = nxt
                continue

            sh, pos, sd = chosen
            used_ranges[sh["id"]].append((pos, pos + sd))
            uses[sh["id"]] += 1
            cuts.append({"section": bp["name"], "shot": sh["id"],
                         "src_in": round(pos, 3), "dur": round(dur, 3),
                         "src_dur": round(sd, 3), "tl": round(t, 3),
                         "fill": round(max(0.0, dur - sd), 3),
                         "_film": sh["start"],
                         "transition": spec.get("transition", "cut")})
            t = nxt
            i += 1
    # Post-pass: force story order. The selection above keeps each source piece
    # unique but a fallback can still land earlier in the film. Sorting each
    # section's pieces by film time and re-assigning them to that section's timeline
    # slots in order makes the narrative strictly forward - the set of shots and the
    # cut durations are unchanged, only which slot each piece occupies.
    for bp in blueprint:
        idxs = [i for i, c in enumerate(cuts)
                if c["section"] == bp["name"] and c.get("shot", -1) >= 0]
        if len(idxs) < 2:
            continue
        slots = [cuts[i] for i in idxs]                       # timeline order
        # COPY: sorting the same dict objects and then assigning between them is a
        # no-op that quietly destroys the edit
        pieces = [dict(c) for c in sorted(slots, key=lambda c: c.get("_film", 0.0))]
        for slot, piece in zip(slots, pieces):
            slot["shot"] = piece["shot"]
            slot["src_in"] = piece["src_in"]
            slot["src_dur"] = piece["src_dur"]
            slot["_film"] = piece.get("_film", 0.0)
            slot["fill"] = round(max(0.0, float(slot["dur"]) - float(piece["src_dur"])), 3)
    return {"cuts": cuts, "notes": plan.get("notes", ""),
            "plan": plan, "blueprint": blueprint}


def plan(backend="local", model=None, api_key=None, blueprint=None):
    beats = load_json("beats.json")
    shots = load_json("shots.json")
    bp = blueprint or default_blueprint(beats["duration"])

    fmap = build_film_map(shots)
    if fmap:
        print(f"      内容地图 {len(fmap)} 个分桶")

    spine = []
    if backend != "none" and fmap:
        spine = story_spine(fmap, backend, model, api_key)
        if spine:
            for e in spine[:12]:
                print(f"        {e.get('film',[0,0])[0]:5.0f}-{e.get('film',[0,0])[1]:5.0f}分  "
                      f"{str(e.get('what',''))[:70]}")
    payload = build_plan_payload(beats, shots, bp, fmap, spine)
    print(f"[plan] backend={backend}  prompt={len(payload)} 字符")

    story = None
    if backend != "none":
        for attempt in (1, 2):
            try:
                raw = call_llm(payload, backend, model, api_key) if attempt == 1 else \
                    call_llm(payload + "\n\nONLY the JSON object. No prose.",
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


def default_blueprint(duration: float):
    """Five-section structure scaled to whatever the song actually is."""
    fractions = [("intro", 0.00, 0.19, "sparse, world-building", ["establishing", "sky", "ruins"]),
                 ("verse", 0.19, 0.40, "gentle narration", ["character", "close-up", "quiet"]),
                 ("chorus1", 0.40, 0.56, "explosive action", ["battle", "fire", "running"]),
                 ("bridge", 0.56, 0.83, "despair, sacrifice", ["crying", "broken", "collapse"]),
                 ("outro", 0.83, 1.00, "transcendence, white", ["light", "white", "smile"])]
    out = []
    for name, a, b, mood, kw in fractions:
        out.append({"name": name, "start": round(duration * a, 2),
                    "end": round(duration * b, 2), "mood": mood, "keywords": kw})
    return out


def expand_beats(story, beats, shots, blueprint, max_uses_per_shot=1):
    """Realise story beats: each section draws from ITS film range, no reuse.

    Sections are laid down in SONG order; a beat marked flashback simply points at an
    earlier film range, which is the one sanctioned way the picture goes backwards.
    """
    beat_arr = np.array(beats["beats"])
    bs = beats["beats"]
    good = [x for x in shots if x.get("usable", True)] or shots
    good = score_shots(good, blueprint)      # CLIP scores for ranking inside a range
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


def probe_duration(path):
    import subprocess
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def _fade_seconds(spec):
    """Transition name -> seconds of overlap; 'cut' -> 0."""
    if not spec:
        return 0.0
    spec = str(spec).lower()
    if spec.startswith("cut"):
        return 0.0
    m = re.search(r"([0-9.]+)\s*s?$", spec)
    v = float(m.group(1)) if m else 0.5
    return max(0.0, min(1.5, v))


def polish_subs(ass_in, ass_out, windows, total, min_dur=2.2):
    """Reflow subtitle events into the clip windows so nothing flashes or gaps."""
    header, events = parse_ass(ass_in)
    if not events:
        return ass_in
    events.sort(key=lambda x: x[0])

    out, carry = [], None
    for (t0, t1) in windows:
        t0 = max(0.0, t0); t1 = min(total, t1)
        win = t1 - t0
        if win <= 0.05:
            continue
        lines = []
        for (a, b, rest) in events:
            if b <= t0 + 0.001 or a >= t1 - 0.001:
                continue
            txt = re.sub(r"\{[^}]*\}", "", rest.split(",", 6)[-1]).strip()
            if txt:
                lines.append(txt)
        # 同一个窗口里重复的台词只留一次
        lines = list(dict.fromkeys(lines))
        if lines:
            # 不让每句短于 MIN_DUR：放不下的就丢掉多余的
            keep = max(1, min(len(lines), int(win / min_dur)))
            lines = lines[-keep:] if len(lines) > keep else lines
            share = win / len(lines)
            for i, txt in enumerate(lines):
                st = t0 + i * share
                en = t1 if i == len(lines) - 1 else st + share
                out.append((st, en, txt))
            carry = lines[-1]
        elif carry:
            out.append((t0, t1, carry))       # 这一段没有自己的台词，接住上一句
    if not out:
        return ass_in

    def ts(t):
        t = max(0.0, min(t, total))
        h = int(t // 3600); m = int(t % 3600 // 60); sec = t % 60
        return f"{h}:{m:02d}:{sec:05.2f}"

    style = "Default"
    for ln in header:
        if ln.lower().startswith("style:"):
            style = ln.split(",")[0].split(":")[1].strip()
            break
    body = "\n".join(f"Dialogue: 0,{ts(a)},{ts(b)},{style},,0,0,0,,{t}" for a, b, t in out)
    open(ass_out, "w", encoding="utf-8").write("\n".join(header) + "\n" + body + "\n")
    durs = [b - a for a, b, _ in out]
    print(f">> 字幕重排: {len(events)} 条 → {len(out)} 条  "
          f"最短 {min(durs):.2f}s  平均 {sum(durs)/len(durs):.2f}s")
    return ass_out


def render_clips(plan_path, song, out="clips.mp4", width=1920, height=1080, fps=24,
                 grade="ngnl", crf=18, remap_subs=None, sub_fontsize=None,
                 hwaccel=None, encoder="libx264", fit_song=True, preview_seconds=0.0,
                 lyrics=None, quotes=None, end_s=None):
    plan = load_json(plan_path)
    clips = plan.get("clips") or []
    if not clips:
        die("计划里没有 clips")
    meta = plan.get("project_meta") or {}

    beats = load_json("beats.json")
    src = beats.get("footage") or "footage/ngnl_zero.mkv"

    song_dur = probe_duration(song) or beats["duration"]
    if end_s and 0 < end_s < song_dur:
        # 只用到歌曲的某一段（例如在乐句小结处收束）
        print(f"[clips] 只取歌曲前 {end_s:.1f}s（全曲 {song_dur:.1f}s）")
        song_dur = end_s
    plan_total = float(meta.get("total_duration_s") or
                       max(c["music_end_s"] for c in clips))
    scale = 1.0
    if fit_song and plan_total > 0:
        scale = song_dur / plan_total
        print(f"[clips] 歌曲 {song_dur:.1f}s / 计划 {plan_total:.0f}s → 时间轴缩放 {scale:.3f}")

    gr = GRADES.get(grade, "")
    base_vf = f"scale={width}:{height}:force_original_aspect_ratio=decrease," \
              f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1" + ("," + gr if gr else "")

    parts_dir = os.path.join(WORK, "clipparts")
    os.makedirs(parts_dir, exist_ok=True)   # keep + reuse parts when durations match

    enc_args = (["-c:v", encoder, "-preset", "p4", "-cq", str(crf), "-rc", "vbr"]
                if encoder.endswith("_nvenc")
                else ["-c:v", encoder, "-preset", "veryfast", "-crf", str(crf)])
    hw_in = ["-hwaccel", hwaccel] if hwaccel else []

    # Crossfades shorten the assembled length. Spreading that loss over the slots
    # BEFORE rendering keeps picture and song locked together; stretching the finished
    # video instead would drift the picture ~5% away from the music (and from lyrics).
    raw_slots = [(float(c.get("music_end_s") or 0) - float(c.get("music_start_s") or 0)) * scale
                 for c in clips]
    raw_fades = [_fade_seconds(c.get("transition_out")) for c in clips]
    loss = sum(min(raw_fades[j], raw_slots[j] * 0.4, raw_slots[j + 1] * 0.4)
               for j in range(len(clips) - 1))
    slot_mult = 1.0
    if sum(raw_slots) > 0.1:
        slot_mult = song_dur / max(0.1, sum(raw_slots) - loss)
    if abs(slot_mult - 1.0) > 0.002:
        print(f"      转场吃掉 {loss:.1f}s → 每个片段预先放大 ×{slot_mult:.4f}（不再整体拉伸）")

    segs, timeline = [], []
    for i, c in enumerate(clips):
        t0 = float(c.get("music_start_s") or 0.0) * scale * slot_mult
        t1 = float(c.get("music_end_s") or 0.0) * scale * slot_mult
        slot = max(0.15, t1 - t0)
        has_range = (c.get("film_start_s") is not None
                     and c.get("film_end_s") is not None)
        if c.get("source_type") not in (None, "video_shot") or not has_range:
            # the cover image was never supplied; stand in with the film's white void
            fs, fe = 0.0, 6.0
            print(f"      clip{i+1}: 非视频素材（{c.get('asset_file','?')}）→ 用片头替代")
        else:
            fs = float(c.get("film_start_s") or 0.0)
            fe = float(c.get("film_end_s") or 0.0)
        src_dur = max(0.2, fe - fs)
        # keep the WHOLE chosen source range and land it in the slot, so nothing the
        # plan wanted is dropped; the requested slow-motion just becomes less extreme
        setpts = f"setpts={slot/src_dur:.6f}*(PTS-STARTPTS)"
        vf = f"{base_vf},{setpts},fps={fps}"
        # the part name carries the source spec: reusing by duration alone silently
        # kept stale footage when a plan changed without changing the slot length
        sig = hashlib.md5(f"{fs:.3f}|{src_dur:.3f}|{slot:.3f}|{grade}|{width}x{height}"
                          f"|{fps}".encode()).hexdigest()[:10]
        outp = os.path.join(parts_dir, f"c{i:03d}_{sig}.mp4")
        if os.path.exists(outp) and abs(probe_duration(outp) - slot) < 0.15:
            pass                                   # already rendered, reuse
        else:
            r = sh(["ffmpeg", "-y", "-v", "error", *hw_in, "-ss", f"{fs:.3f}",
                    "-t", f"{src_dur:.3f}", "-i", src, "-an", "-vf", vf,
                    "-t", f"{slot:.3f}", *enc_args, "-pix_fmt", "yuv420p", outp])
            if r.returncode != 0:
                die(f"clip{i+1} 渲染失败")
        segs.append({"path": outp, "dur": slot, "fade": _fade_seconds(c.get("transition_out")),
                     "note": c.get("narrative_note", ""), "shot": c.get("shot_id"),
                     "src_in": fs, "src_dur": src_dur})
        timeline.append({"src_in": fs, "dur": src_dur, "tl": t0, "shot": c.get("shot_id"),
                         "slot": slot, "time_scale": slot / src_dur,
                         "section": c.get("section", ""),
                         "transition": c.get("transition_out")})

    # crossfades OVERLAP, so the assembled length is shorter than the sum of the
    # slots; stretch everything slightly at the end so the picture still fills the
    # song instead of getting cut off by -shortest
    stretch = 1.0                      # slots already fill the song; no global stretch
    total = sum(x["dur"] for x in segs) - sum(
        min(x["fade"], x["dur"] * 0.4) for x in segs[:-1])

    # ---- build the transition chain
    inputs = []
    for x in segs:
        inputs += ["-i", x["path"]]
    # xfade refuses inputs whose timebases differ, and concat changes the timebase,
    # so every stream is forced to the same rate/base before the chain is built
    parts, prev, acc = [], "[0:v]", segs[0]["dur"]
    norm = [f"[{i}:v]fps={fps},settb=AVTB,setpts=PTS-STARTPTS[v{i}]"
            for i in range(len(segs))]
    prev = "[v0]"
    for i in range(1, len(segs)):
        fade = min(segs[i - 1]["fade"], segs[i - 1]["dur"] * 0.4, segs[i]["dur"] * 0.4)
        lbl = f"[vx{i}]"
        if fade > 0.04:
            parts.append(f"{prev}[v{i}]xfade=transition=fade:duration={fade:.3f}"
                         f":offset={max(0.0, acc - fade):.3f}{lbl}")
            acc = acc + segs[i]["dur"] - fade
        else:
            parts.append(f"{prev}[v{i}]concat=n=2:v=1:a=0{lbl}")
            acc += segs[i]["dur"]
        prev = lbl
    fg = ";".join(norm + parts)
    silent = os.path.join(WORK, "clips_silent.mp4")
    cmd = ["ffmpeg", "-y", "-v", "error", *inputs,
           "-filter_complex", fg, "-map", prev, *enc_args,
           "-pix_fmt", "yuv420p", "-r", str(fps), silent]
    r = sh(cmd)
    if r.returncode != 0:
        die("拼接失败")
    print(f"      拼接完成 {probe_duration(silent):.1f}s")

    if remap_subs or lyrics or quotes:
        chain = []
        if remap_subs:
            tl_scaled = [{**c, "tl": c["tl"] * stretch,
                          "time_scale": c["time_scale"] * stretch} for c in timeline]
            edl = {"cuts": tl_scaled, "blueprint": []}
            remap_ass(remap_subs, edl, out="clips_subs.ass", width=width, height=height,
                      fontsize=sub_fontsize)
            # clips already carry their stretched position; reflow within them
            wins = []
            for c in timeline:
                a = c["tl"] * stretch
                wins.append((a, a + c["slot"] * stretch))
            polished = polish_subs(os.path.join(WORK, "clips_subs.ass"),
                                   os.path.join(WORK, "clips_subs2.ass"),
                                   wins, song_dur)
            chain.append(f"subtitles={polished}")
        if lyrics:
            # the whole picture is stretched to fill the song, so the lyric file's
            # absolute times have to be stretched by the same factor or they drift
            if abs(stretch - 1.0) > 0.002:
                src_a = open(lyrics, encoding="utf-8-sig", errors="replace").read()
                rebuilt = []          # NB: not `out` - that is this function's output path
                for ln in src_a.splitlines():
                    if ln.startswith("Dialogue:"):
                        f = ln.split(",", 3)
                        for k in (1, 2):
                            try:
                                f[k] = _ass_ts(_ass_time(f[k]) * stretch)
                            except Exception:
                                pass
                        ln = ",".join(f)
                    rebuilt.append(ln)
                lp = os.path.join(WORK, "clips_lyrics_scaled.ass")
                open(lp, "w", encoding="utf-8").write("\n".join(rebuilt) + "\n")
                lyrics = lp
            chain.append(f"subtitles={lyrics}")
        if quotes:
            chain.append(f"subtitles={quotes}")   # already on the final timeline
        vfile = os.path.join(WORK, "clips_v.mp4")
        r = sh(["ffmpeg", "-y", "-v", "error", "-i", silent,
                "-vf", ",".join(chain), *enc_args, "-pix_fmt", "yuv420p", vfile])
        if r.returncode != 0:
            die("字幕/歌词烧制失败")
        silent = vfile

    # fade out the picture over the last 1.5 s
    fin = os.path.join(WORK, "clips_final.mp4")
    d = probe_duration(silent)
    r = sh(["ffmpeg", "-y", "-v", "error", "-i", silent, "-vf",
            f"fade=t=out:st={max(0, d-1.5):.2f}:d=1.5", *enc_args,
            "-pix_fmt", "yuv420p", fin])
    if r.returncode == 0:
        silent = fin

    r = sh(["ffmpeg", "-y", "-v", "error", "-i", silent, "-i", song,
            "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
            "-b:a", "192k", "-shortest",
            *(["-t", f"{song_dur:.3f}"] if end_s else []), out])
    if r.returncode != 0:
        die("音视频合成失败")
    print(f">> {out}  {probe_duration(out):.1f}s  "
          f"{os.path.getsize(out)/1048576:.1f} MB  {len(segs)} 个片段")
    save_json("clips_timeline.json",
              {"clips": timeline, "segments": [{k: v for k, v in x.items() if k != 'path'}
                                               for x in segs]})
    return out


# --------------------------------------------------------------------- render
GRADES = {
    "none": "",
    # 《游戏人生 零》风格：高对比暗部 + 青紫边缘光 + 高光辉光
    "ngnl": ("eq=contrast=1.12:saturation=1.06,"
             "colorbalance=rs=-0.04:gs=0.01:bs=0.08:rh=0.05:gh=-0.02:bh=0.07,"
             "vignette=PI/6,unsharp=3:3:0.3"),
    "warm": "eq=contrast=1.06:saturation=1.12,colorbalance=rs=0.05:bs=-0.05",
    "mono": "hue=s=0,eq=contrast=1.15",
}


def render(width=1920, height=1080, fps=24, grade="ngnl", xfade=0.0,
           crf=18, out="out.mp4", subtitles=None, preview_seconds=0.0,
           remap_subs=None, sub_fontsize=None, encoder="libx264", hwaccel=None):
    edl = load_json("edl.json")
    src = edl.get("footage") or load_json("beats.json").get("footage")
    src = src or find_footage()
    if not src:
        die("找不到素材文件（edl.footage / --footage）")
    cuts = edl["cuts"]
    if remap_subs:
        subtitles = remap_ass(remap_subs, edl, width=width, height=height,
                              fontsize=sub_fontsize)
    if preview_seconds:
        acc, keep = 0.0, []
        for c in cuts:
            if acc >= preview_seconds:
                break
            keep.append(c); acc += c["dur"]
        cuts = keep
        print(f"[render] 预览模式：只渲染前 {acc:.1f}s")
    parts = os.path.join(WORK, "parts")
    shutil.rmtree(parts, ignore_errors=True)
    os.makedirs(parts, exist_ok=True)
    g = GRADES.get(grade, grade if grade not in GRADES else "")
    vf = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},fps={fps},setsar=1"
    if g:
        vf += "," + g
    files = []
    t0 = time.time()
    if encoder.endswith("_nvenc"):
        enc_args = ["-c:v", encoder, "-preset", "p4", "-cq", str(crf), "-rc", "vbr"]
    else:
        enc_args = ["-c:v", encoder, "-preset", "veryfast", "-crf", str(crf)]
    hw_in = ["-hwaccel", hwaccel] if hwaccel else []
    for n, c in enumerate(cuts):
        outp = os.path.join(parts, f"p{n:05d}.mp4")
        a = max(0.0, c["src_in"])
        sd = float(c.get("src_dur") or c["dur"])
        td = max(0.05, float(c["dur"]))
        chain = vf
        if td - sd > 0.03:
            # hold the last frame so the segment still occupies its full slot
            chain += f",tpad=stop_mode=clone:stop_duration={td - sd:.3f}"
        chain += f",trim=duration={td:.3f},setpts=PTS-STARTPTS"
        r = sh(["ffmpeg", "-y", "-v", "error", *hw_in, "-ss", f"{a:.3f}", "-t", f"{sd:.3f}",
                "-i", src, "-an", "-vf", chain, *enc_args,
                "-pix_fmt", "yuv420p", outp])
        if r.returncode != 0:
            die(f"切第 {n} 段失败: {r.stderr[:300]}")
        files.append(outp)
        if n % 25 == 0:
            print(f"      {n}/{len(cuts)}  {time.time()-t0:.0f}s")
    lst = os.path.join(parts, "list.txt")
    with open(lst, "w") as fh:
        for f in files:
            fh.write(f"file '{f}'\n")
    silent = os.path.join(WORK, "parts", "silent.mp4")
    r = sh(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst,
            "-c", "copy", silent])
    if r.returncode != 0:
        die(f"拼接失败: {r.stderr[:300]}")

    song = load_json("beats.json")["song"]
    tmp = os.path.join(WORK, "parts", "with_subs.mp4")
    vfile = silent
    if subtitles:
        vfile = tmp
        r = sh(["ffmpeg", "-y", "-v", "error", "-i", silent, "-vf",
                f"subtitles={subtitles}", *enc_args,
                "-pix_fmt", "yuv420p", vfile])
        if r.returncode != 0:
            print(f"  警告: 字幕烧制失败 ({r.stderr[:160]})，输出无字幕版本")
            vfile = silent
    outpath = os.path.join(WORK, out)
    r = sh(["ffmpeg", "-y", "-v", "error", "-i", vfile, "-i", song,
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", outpath])
    if r.returncode != 0:
        die(f"合音轨失败: {r.stderr[:300]}")
    dur = probe_duration(outpath)
    print(f"\n>> {outpath}  {dur:.1f}s  {os.path.getsize(outpath)/1e6:.1f} MB  "
          f"{len(cuts)} 个切点  用时 {time.time()-t0:.0f}s")
    return outpath


def find_footage():
    for name in ("standin.mp4",):
        p = os.path.join(WORK, "footage", name)
        if os.path.exists(p):
            return p
    d = os.path.join(WORK, "footage")
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if f.lower().endswith((".mp4", ".mkv", ".mov")):
                return os.path.join(d, f)
    return None


# --------------------------------------------------------------------- subtitles
def _ass_time(t: str) -> float:
    h, m, sec = t.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + float(sec)


def _ass_ts(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def parse_ass(path: str):
    """Return (header_lines, events) where events = [(start, end, rest_of_line)]."""
    raw = open(path, encoding="utf-8-sig", errors="replace").read()
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    lines = raw.split("\n")
    header, events = [], []
    in_events = False
    for line in lines:
        if line.strip().startswith("[Events]"):
            in_events = True
            header.append(line)
            continue
        if not in_events:
            header.append(line)
            continue
        if line.startswith("Dialogue:"):
            body = line[len("Dialogue:"):].lstrip()
            parts = body.split(",", 9)
            if len(parts) < 10:
                continue
            try:
                a, b = _ass_time(parts[1]), _ass_time(parts[2])
            except Exception:
                continue
            events.append((a, b, ",".join(parts[3:])))
        elif line.startswith("Format:") or line.startswith("Comment:"):
            header.append(line)
    return header, events


def remap_ass(src_ass: str, edl: dict, out="remapped.ass",
              width=1920, height=1080, fontsize=None, margin_v=None):
    """Clip every subtitle event to the cuts that use its source range."""
    header, events = parse_ass(src_ass)
    if not events:
        die(f"{src_ass} 里没有可用的 Dialogue 行")

    # libass treats PlayResX/Y=0 badly once strict scaling kicks in; set them
    fixed = []
    play_y = 0
    for line in header:
        if line.strip().lower().startswith("playresy:"):
            try:
                play_y = int(line.split(":")[1].strip())
            except ValueError:
                play_y = 0
        fixed.append(line)
    out_hdr = []
    for line in fixed:
        k = line.split(":")[0].strip().lower() if ":" in line else ""
        if k == "playresx":
            out_hdr.append(f"PlayResX: {width}")
        elif k == "playresy":
            out_hdr.append(f"PlayResY: {height}")
        elif k == "scripttype":
            out_hdr.append("ScriptType: v4.00+")
        elif k == "style":
            f = line.split(",", 23)
            # 0=Style 1=Fontname 2=Fontsize ... patch font for CJK + readable size
            if len(f) > 22:
                if fontsize:
                    f[2] = str(fontsize)
                else:
                    # original PlayRes was unset -> libass assumed ~288 lines
                    base = play_y or 288
                    f[2] = str(max(28, round(float(f[2] or 20) * height / base)))
                f[1] = "Noto Serif CJK SC"
                if margin_v:
                    f[21] = str(margin_v)
                line = ",".join(f)
            out_hdr.append(line)
        else:
            out_hdr.append(line)

    made = 0
    out_ev = []
    for c in edl["cuts"]:
        s0, dur, tl = float(c["src_in"]), float(c["dur"]), float(c["tl"])
        s1 = s0 + dur
        # when the clip is retimed (slow motion, or stretched to fit a slot) the
        # source seconds map to a different number of timeline seconds - without this
        # every subtitle drifts by the speed factor
        sc = float(c.get("time_scale") or 1.0)
        for (a, b, rest) in events:
            if b <= s0 or a >= s1:
                continue
            ns = tl + max(0.0, a - s0) * sc
            ne = tl + min(dur, b - s0) * sc
            if ne - ns < 0.12:
                continue
            out_ev.append((ns, ne, rest))
            made += 1
    out_ev.sort(key=lambda x: x[0])
    # collapse duplicates introduced by adjacent cuts re-using the same line
    dedup = []
    for e in out_ev:
        if dedup and abs(e[0] - dedup[-1][0]) < 0.02 and e[2] == dedup[-1][2]:
            continue
        dedup.append(e)
    body = "\n".join(f"Dialogue: 0,{_ass_ts(a)},{_ass_ts(b)},{rest}"
                     for (a, b, rest) in dedup)
    p = os.path.join(WORK, out)
    os.makedirs(os.path.dirname(p) or WORK, exist_ok=True)
    open(p, "w", encoding="utf-8").write("\n".join(out_hdr) + "\n" + body + "\n")
    print(f">> 字幕重映射: {len(events)} 条原始 → {len(dedup)} 条新时间轴 → {p}")
    return p


def make_ass(lyrics_json: str, out="lyrics.ass", width=1920, height=1080):
    """lyrics.json: [{"start":0.0,"end":3.0,"text":"...","style":"dragon"}]"""
    lines = json.load(open(lyrics_json))
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Serif CJK SC,64,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,60,60,80,1
Style: dragon,Noto Serif CJK SC,60,&H00E8C8FF,&H00201018,&H80000000,0,0,0,0,100,100,2,0,1,3,2,2,60,60,80,1
Style: jp,Noto Serif CJK SC,56,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,60,60,110,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    def ts(t):
        h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
        return f"{h}:{m:02d}:{s:05.2f}"
    ev = []
    for L in lines:
        style = L.get("style", "Default")
        txt = L["text"].replace("\n", "\\N")
        ev.append(f"Dialogue: 0,{ts(float(L['start']))},{ts(float(L['end']))},"
                  f"{style},,0,0,0,,{txt}")
    p = os.path.join(WORK, out)
    open(p, "w").write(header + "\n".join(ev) + "\n")
    print(f">> {p}  {len(ev)} 条字幕")
    return p


# --------------------------------------------------------------------- cli
def main():
    ap = argparse.ArgumentParser(prog="edit", description="全自动 AI 剪辑")
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("analyze"); a.add_argument("footage"); a.add_argument("song")
    a.add_argument("--skip-clip", action="store_true")
    a.add_argument("--max-shots", type=int, default=4000)
    a.add_argument("--detect-on", default=None,
                   help="低分辨率代理，只用于镜头检测（渲染仍用 footage）")
    a.add_argument("--subs", default=None, help="原片 .ass，用于给镜头挂台词")

    s = sub.add_parser("search"); s.add_argument("query"); s.add_argument("--top", type=int, default=10)

    p = sub.add_parser("plan")
    p.add_argument("--backend", default="local", choices=["local", "deepseek", "none"])
    p.add_argument("--model", default=None)
    p.add_argument("--api-key", default=None)
    p.add_argument("--blueprint", default=None, help="JSON 文件，自定义五段结构")

    r = sub.add_parser("render")
    r.add_argument("--width", type=int, default=1920); r.add_argument("--height", type=int, default=1080)
    r.add_argument("--fps", type=int, default=24)
    r.add_argument("--grade", default="ngnl"); r.add_argument("--crf", type=int, default=18)
    r.add_argument("--out", default="out.mp4"); r.add_argument("--subtitles", default=None)
    r.add_argument("--remap-subs", default=None,
                   help="原片 .ass，按剪辑表重映射后烧进成片")
    r.add_argument("--sub-fontsize", type=int, default=None)
    r.add_argument("--encoder", default="libx264",
                   choices=["libx264", "h264_nvenc", "hevc_nvenc"])
    r.add_argument("--hwaccel", default=None, choices=["cuda", "auto"],
                   help="GPU 解码；10bit HEVC 提速约 20%%")
    r.add_argument("--preview", type=float, default=0.0)

    m = sub.add_parser("ass"); m.add_argument("lyrics_json")
    c = sub.add_parser("render-clips", help="按显式镜头表渲染（不自动剪辑）")
    c.add_argument("plan"); c.add_argument("song")
    c.add_argument("--out", default="clips.mp4")
    c.add_argument("--width", type=int, default=1920)
    c.add_argument("--height", type=int, default=1080)
    c.add_argument("--fps", type=int, default=24)
    c.add_argument("--grade", default="ngnl")
    c.add_argument("--crf", type=int, default=18)
    c.add_argument("--remap-subs", default=None)
    c.add_argument("--sub-fontsize", type=int, default=None)
    c.add_argument("--hwaccel", default=None, choices=["cuda", "auto"])
    c.add_argument("--encoder", default="libx264",
                   choices=["libx264", "h264_nvenc", "hevc_nvenc"])
    c.add_argument("--no-fit", action="store_true", help="不按歌曲时长缩放时间轴")
    c.add_argument("--lyrics", default=None, help="竖排歌词 ASS（叠加在字幕之上）")
    c.add_argument("--quotes", default=None, help="精选独白 ASS（成片时间轴，不缩放）")
    c.add_argument("--end", type=float, default=None, help="只用歌曲前 N 秒")
    d = sub.add_parser("dialogue", help="只给已有镜头挂台词（不重算 CLIP）")
    d.add_argument("subs")

    run = sub.add_parser("run"); run.add_argument("footage"); run.add_argument("song")
    run.add_argument("--backend", default="local"); run.add_argument("--model", default=None)
    run.add_argument("--grade", default="ngnl"); run.add_argument("--preview", type=float, default=0.0)

    a = ap.parse_args()
    if a.cmd == "analyze":
        analyze(a.footage, a.song, a.max_shots, a.skip_clip, a.detect_on, a.subs)
    elif a.cmd == "search":
        search(a.query, a.top)
    elif a.cmd == "plan":
        bp = json.load(open(a.blueprint)) if a.blueprint else None
        plan(a.backend, a.model, a.api_key, bp)
    elif a.cmd == "render":
        render(a.width, a.height, a.fps, a.grade, 0.0, a.crf, a.out,
               a.subtitles, a.preview, a.remap_subs, a.sub_fontsize,
               a.encoder, a.hwaccel)
    elif a.cmd == "render-clips":
        render_clips(a.plan, a.song, a.out, a.width, a.height, a.fps, a.grade,
                     a.crf, a.remap_subs, a.sub_fontsize, a.hwaccel, a.encoder,
                     not a.no_fit, lyrics=a.lyrics, quotes=a.quotes, end_s=a.end)
    elif a.cmd == "dialogue":
        sh = load_json("shots.json")
        sh = attach_dialogue(sh, a.subs)
        save_json("shots.json", sh)
    elif a.cmd == "ass":
        make_ass(a.lyrics_json)
    elif a.cmd == "run":
        analyze(a.footage, a.song)
        plan(a.backend, a.model)
        render(grade=a.grade, preview_seconds=a.preview)


if __name__ == "__main__":
    main()
