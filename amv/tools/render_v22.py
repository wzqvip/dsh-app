#!/usr/bin/env python3
"""Render the user's v22 edit (from their Premiere XML) into a finished mp4.

Two things make this different from earlier renders:
  * the XML carries Premiere's -1 sentinels for start/end, so the timeline has to be
    reconstructed: -1 start means "continue from the previous clip", -1 end means
    "start + (out - in)". Some clips are also retimed (timeline length != source
    length), which becomes a per-clip setpts.
  * the subtitles are burned here instead of being handed over as transparent
    overlays, which is what caused the black fringing in Premiere.
"""
import json
import os
import subprocess
import sys
import re
import xml.etree.ElementTree as ET

FPS = 24
SRC = "/home/taco/edit/source/footage/ngnl_zero.mkv"
XML = "/home/taco/edit/work/NGNL_v22.xml"
OUTDIR = "/home/taco/edit/work/v22"
FINAL = "/home/taco/edit/out/final_v22.mp4"
SONG = "/home/taco/gen/audio/song_1794608919.flac"
GRADE = ("eq=contrast=1.12:saturation=1.06,"
         "colorbalance=rs=-0.04:gs=0.01:bs=0.08:rh=0.05:gh=-0.02:bh=0.07,"
         "vignette=PI/6,unsharp=3:3:0.3")

tree = ET.parse(XML)
seq = tree.getroot().find("sequence")
vt = seq.find("media/video").findall("track")
v1 = vt[0].findall("clipitem")

clips, prev_end = [], 0
for it in v1:
    s = int(it.findtext("start") or -1)
    e = int(it.findtext("end") or -1)
    i_ = int(it.findtext("in") or 0)
    o = int(it.findtext("out") or 0)
    s = prev_end if s < 0 else s
    e = (s + (o - i_)) if e < 0 else e
    if e <= s:
        e = s + (o - i_)
    # 引用 shots_clip 库文件的片段，in/out 是相对那个文件的，要加上文件自己的起点
    fn = it.find("file").findtext("name") or "" if it.find("file") is not None else ""
    m = re.match(r"^(\d{4})_(\d+\.\d+)-", fn)
    off = float(m.group(2)) if m else 0.0
    if off:
        print(f"  库文件偏移 +{off:.2f}s  {fn[:34]}")
    clips.append({"name": it.findtext("name") or "", "s": s, "e": e,
                  "in": i_, "out": o, "off": off})
    prev_end = e

total_frames = prev_end
print(f"{len(clips)} 段  时间轴 {total_frames/FPS:.2f}s")
for c in clips:
    tl = (c["e"] - c["s"]) / FPS
    sd = (c["out"] - c["in"]) / FPS
    c["speed"] = (c["out"] - c["in"]) / max(1, (c["e"] - c["s"]))
    if abs(c["speed"] - 1) > 0.02:
        print(f"  {c['name'][:26]:28s} {tl:6.2f}s  源 {sd:6.2f}s  速度 x{c['speed']:.3f}")

os.makedirs(OUTDIR, exist_ok=True)
parts = []
for k, c in enumerate(clips, 1):
    tl = (c["e"] - c["s"]) / FPS
    src_in = c["off"] + c["in"] / FPS
    src_dur = (c["out"] - c["in"]) / FPS
    outp = os.path.join(OUTDIR, f"p{k:02d}.mp4")
    if False and os.path.exists(outp) and abs(float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", outp], capture_output=True, text=True).stdout or 0) - tl) < 0.2:
        parts.append(outp); continue
    vf = (f"scale=1920:1080:force_original_aspect_ratio=decrease,"
          f"pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,{GRADE},"
          f"setpts={tl/src_dur:.6f}*(PTS-STARTPTS),fps={FPS}")
    r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{src_in:.3f}",
                        "-t", f"{src_dur:.3f}", "-i", SRC, "-an", "-vf", vf,
                        "-t", f"{tl:.3f}", "-c:v", "libx264", "-crf", "16",
                        "-preset", "veryfast", "-pix_fmt", "yuv420p", outp],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"ERR clip {k}: {r.stderr[-300:]}"); sys.exit(1)
    parts.append(outp)
    print(f"  {k:2d}/{len(clips)} {tl:6.2f}s  {c['name'][:30]}")

lst = os.path.join(OUTDIR, "concat.txt")
open(lst, "w").write("\n".join(f"file '{p}'" for p in parts) + "\n")
silent = os.path.join(OUTDIR, "silent.mp4")
subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
                "-i", lst, "-c", "copy", silent], check=True)
print(f"  拼接完成 {total_frames/FPS:.2f}s")
print(total_frames / FPS)
