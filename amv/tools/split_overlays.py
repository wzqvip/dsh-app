#!/usr/bin/env python3
"""Split the subtitle overlays into ONE transparent clip per line.

Editing in Premiere is much easier when each caption is its own clip: you can trim,
stretch or retime a single sentence without touching its neighbours. Each file keeps
the exact styling of the finished video (vertical columns, rotation, colour) and is
rendered with its natural fade already baked in.
"""
import os
import re
import subprocess
import sys

W, H, FPS = 1920, 1080, 24
ROOT = "/home/taco/edit"
OUT = os.path.join(ROOT, "export", "overlay")


def ass_t(t):
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def ts(t):
    t = max(0.0, t)
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def parse(path):
    header, events = [], []
    in_ev = False
    for ln in open(path, encoding="utf-8-sig", errors="replace"):
        ln = ln.rstrip("\n")
        if ln.strip().startswith("[Events]"):
            in_ev = True
            header.append(ln)
            continue
        if not in_ev:
            header.append(ln)
            continue
        if ln.startswith("Dialogue:"):
            f = ln.split(",", 9)
            events.append({"start": ass_t(f[1]), "end": ass_t(f[2]),
                           "style": f[3], "text": f[9]})
        elif ln.startswith("Format:"):
            header.append(ln)
    return header, events


def groups(events):
    """Columns of one lyric line share the same start/end - group them."""
    g = {}
    for e in events:
        g.setdefault((round(e["start"], 2), round(e["end"], 2)), []).append(e)
    return sorted(g.items())


def clean(t):
    t = re.sub(r"\{\\[^}]*\}", "", t).replace("\\N", "")
    t = re.sub(r"[^\w\u3040-\u30ff\u4e00-\u9fff]+", "", t)
    return t[:18] or "line"


def render(header, evs, dur, out_path):
    body = "\n".join(
        f"Dialogue: 0,{ts(0)},{ts(dur)},{e['style']},,0,0,0,,{e['text']}" for e in evs)
    tmp = "/tmp/one.ass"
    open(tmp, "w", encoding="utf-8").write("\n".join(header) + "\n" + body + "\n")
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:r={FPS}:d={dur:.3f}",
           "-vf", f"subtitles={tmp},format=rgba,colorkey=0x000000:0.08:0.0",
           "-c:v", "qtrle", "-pix_fmt", "argb", out_path]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode == 0


def do(ass_file, folder, prefix):
    header, events = parse(ass_file)
    dst = os.path.join(OUT, folder)
    os.makedirs(dst, exist_ok=True)
    rows = []
    for i, ((a, b), evs) in enumerate(groups(events), 1):
        dur = max(0.2, b - a)
        label = clean(evs[0]["text"])
        name = f"{prefix}{i:02d}_{a:06.2f}-{b:06.2f}_{label}.mov"
        ok = render(header, evs, dur, os.path.join(dst, name))
        txt = " / ".join(clean(e["text"]) for e in evs[:2])
        rows.append((i, a, b, dur, name, txt, ok))
        print(f"  {'OK ' if ok else 'ERR'} {name}  ({dur:.2f}s)")
    with open(os.path.join(dst, "_index.csv"), "w", encoding="utf-8") as fh:
        fh.write("index,start_s,end_s,dur_s,file,text\n")
        for i, a, b, d, n, t, ok in rows:
            fh.write(f"{i},{a:.2f},{b:.2f},{d:.2f},{n},{t}\n")
    print(f">> {dst}  {len(rows)} 条")
    return len(rows)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    print("=== 歌词 ===")
    n1 = do(os.path.join(ROOT, "work/lyrics_vertical.ass"), "lyrics", "L")
    print("=== 剧情独白 ===")
    n2 = do(os.path.join(ROOT, "work/quotes.ass"), "narrative", "N")
    print(f"合计 {n1 + n2} 个文件")
