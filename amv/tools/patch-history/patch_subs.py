#!/usr/bin/env python3
"""Add subtitle remapping + proxy support to the edit pipeline.

Remapping is the interesting part: the EDL reorders and trims the film, so the
original .ass timings are useless verbatim. For every cut we take the subtitle
events that overlap its SOURCE range, clip them to that range, and shift them to
the cut's TIMELINE position - so dialogue still matches the picture after cutting.
"""
P = "/home/taco/edit/edit.py"
s = open(P).read()
n = []


def rep(old, new):
    global s
    assert old in s, f"NOT FOUND: {old[:90]!r}"
    s = s.replace(old, new, 1)
    n.append(old[:40])


# ---------------------------------------------------------------- analyze: proxy
rep('''def analyze(footage: str, song: str, max_shots: int = 4000, skip_clip: bool = False):
    os.makedirs(WORK, exist_ok=True)
    t_all = time.time()''',
'''def analyze(footage: str, song: str, max_shots: int = 4000, skip_clip: bool = False,
            detect_source: str | None = None):
    """``footage`` is what gets RENDERED; ``detect_source`` is a fast proxy used for
    scene detection and CLIP frames. Timestamps match because both share fps and
    duration, so analysing a 360p proxy of a 106-minute film takes minutes, not an hour.
    """
    os.makedirs(WORK, exist_ok=True)
    t_all = time.time()
    detect_on = detect_source or footage''')

rep('''    save_json("beats.json", {"song": song, "duration": round(duration, 3),''',
'''    save_json("beats.json", {"song": song, "footage": footage,
                             "detect_source": detect_on,
                             "duration": round(duration, 3),''')

rep('''    print(f"[2/3] 切分镜头 {footage}")''',
'''    print(f"[2/3] 切分镜头 {detect_on}" + (f"（代理，渲染用 {footage}）"
                                          if detect_on != footage else ""))''')
rep('''    video = open_video(footage)''', '''    video = open_video(detect_on)''')
rep('''    cap = cv2.VideoCapture(footage)
    if not cap.isOpened():
        die(f"打不开 {footage}")''',
'''    cap = cv2.VideoCapture(detect_on)
    if not cap.isOpened():
        die(f"打不开 {detect_on}")''')

# ---------------------------------------------------------------- ass remap
rep('''def make_ass(lyrics_json: str, out="lyrics.ass", width=1920, height=1080):''',
'''def _ass_time(t: str) -> float:
    h, m, sec = t.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + float(sec)


def _ass_ts(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def parse_ass(path: str):
    """Return (header_lines, events) where events = [(start, end, rest_of_line)]."""
    raw = open(path, encoding="utf-8-sig", errors="replace").read()
    raw = raw.replace("\\r\\n", "\\n").replace("\\r", "\\n")
    lines = raw.split("\\n")
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
        elif k.startswith("style:"):
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
        for (a, b, rest) in events:
            if b <= s0 or a >= s1:
                continue
            ns = tl + max(0.0, a - s0)
            ne = tl + min(dur, b - s0)
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
    body = "\\n".join(f"Dialogue: 0,{_ass_ts(a)},{_ass_ts(b)},{rest}"
                     for (a, b, rest) in dedup)
    p = os.path.join(WORK, out)
    os.makedirs(os.path.dirname(p) or WORK, exist_ok=True)
    open(p, "w", encoding="utf-8").write("\\n".join(out_hdr) + "\\n" + body + "\\n")
    print(f">> 字幕重映射: {len(events)} 条原始 → {len(dedup)} 条新时间轴 → {p}")
    return p


def make_ass(lyrics_json: str, out="lyrics.ass", width=1920, height=1080):''')

# ---------------------------------------------------------------- render: subs options
rep('''def render(width=1920, height=1080, fps=24, grade="ngnl", xfade=0.0,
           crf=18, out="out.mp4", subtitles=None, preview_seconds=0.0):''',
'''def render(width=1920, height=1080, fps=24, grade="ngnl", xfade=0.0,
           crf=18, out="out.mp4", subtitles=None, preview_seconds=0.0,
           remap_subs=None, sub_fontsize=None):''')

rep('''    cuts = edl["cuts"]
    if preview_seconds:''',
'''    cuts = edl["cuts"]
    if remap_subs:
        subtitles = remap_ass(remap_subs, edl, width=width, height=height,
                              fontsize=sub_fontsize)
    if preview_seconds:''')

# cli wiring
rep('''    r.add_argument("--out", default="out.mp4"); r.add_argument("--subtitles", default=None)''',
'''    r.add_argument("--out", default="out.mp4"); r.add_argument("--subtitles", default=None)
    r.add_argument("--remap-subs", default=None,
                   help="原片 .ass，按剪辑表重映射后烧进成片")
    r.add_argument("--sub-fontsize", type=int, default=None)''')

rep('''        render(a.width, a.height, a.fps, a.grade, 0.0, a.crf, a.out,
               a.subtitles, a.preview)''',
'''        render(a.width, a.height, a.fps, a.grade, 0.0, a.crf, a.out,
               a.subtitles, a.preview, a.remap_subs, a.sub_fontsize)''')

# analyze cli: --detect-on
rep('''    a = sub.add_parser("analyze"); a.add_argument("footage"); a.add_argument("song")
    a.add_argument("--skip-clip", action="store_true")
    a.add_argument("--max-shots", type=int, default=4000)''',
'''    a = sub.add_parser("analyze"); a.add_argument("footage"); a.add_argument("song")
    a.add_argument("--skip-clip", action="store_true")
    a.add_argument("--max-shots", type=int, default=4000)
    a.add_argument("--detect-on", default=None,
                   help="低分辨率代理，只用于镜头检测（渲染仍用 footage）")''')

rep('''        analyze(a.footage, a.song, a.max_shots, a.skip_clip)''',
'''        analyze(a.footage, a.song, a.max_shots, a.skip_clip, a.detect_on)''')

open(P, "w").write(s)
print(f"patched {len(n)} sites")
