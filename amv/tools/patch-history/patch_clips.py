#!/usr/bin/env python3
"""Add `render-clips`: render an explicit clip list (shot ids + film ranges + timing).

This is the opposite of the automatic expander: instead of deciding cuts, it obeys a
plan. Needed because the critique was right - 95 short cuts reads as scattered, while
28 long clips can actually tell the story.

Handles: source range -> target slot with speed change, per-clip transition
(cut / crossfade / flash / fade-to-black), subtitle remap onto the new timeline.
"""
P = "/home/taco/edit/edit.py"
s = open(P).read()

anchor = "# --------------------------------------------------------------------- render"
fn = '''def probe_duration(path):
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
    m = re.search(r"([0-9.]+)\\s*s?$", spec)
    v = float(m.group(1)) if m else 0.5
    return max(0.0, min(1.5, v))


def render_clips(plan_path, song, out="clips.mp4", width=1920, height=1080, fps=24,
                 grade="ngnl", crf=18, remap_subs=None, sub_fontsize=None,
                 hwaccel=None, encoder="libx264", fit_song=True, preview_seconds=0.0):
    plan = load_json(plan_path)
    clips = plan.get("clips") or []
    if not clips:
        die("计划里没有 clips")
    meta = plan.get("project_meta") or {}

    beats = load_json("beats.json")
    src = beats.get("footage") or "footage/ngnl_zero.mkv"

    song_dur = probe_duration(song) or beats["duration"]
    plan_total = float(meta.get("total_duration_s") or
                       max(c["music_end_s"] for c in clips))
    scale = 1.0
    if fit_song and plan_total > 0:
        scale = song_dur / plan_total
        print(f"[clips] 歌曲 {song_dur:.1f}s / 计划 {plan_total:.0f}s → 时间轴缩放 {scale:.3f}")

    gr = GRADES.get(grade, "")
    base_vf = f"scale={width}:{height}:force_original_aspect_ratio=decrease," \\
              f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1" + ("," + gr if gr else "")

    parts_dir = os.path.join(WORK, "clipparts")
    shutil.rmtree(parts_dir, ignore_errors=True)
    os.makedirs(parts_dir, exist_ok=True)

    enc_args = (["-c:v", encoder, "-preset", "p4", "-cq", str(crf), "-rc", "vbr"]
                if encoder.endswith("_nvenc")
                else ["-c:v", encoder, "-preset", "veryfast", "-crf", str(crf)])
    hw_in = ["-hwaccel", hwaccel] if hwaccel else []

    segs, timeline = [], []
    for i, c in enumerate(clips):
        t0 = float(c.get("music_start_s") or 0.0) * scale
        t1 = float(c.get("music_end_s") or 0.0) * scale
        slot = max(0.15, t1 - t0)
        if c.get("source_type") != "video_shot" or c.get("shot_id") is None:
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
        outp = os.path.join(parts_dir, f"c{i:03d}.mp4")
        r = sh(["ffmpeg", "-y", "-v", "error", *hw_in, "-ss", f"{fs:.3f}",
                "-t", f"{src_dur:.3f}", "-i", src, "-an", "-vf", vf,
                "-t", f"{slot:.3f}", *enc_args, "-pix_fmt", "yuv420p", outp])
        if r.returncode != 0:
            die(f"clip{i+1} 渲染失败")
        segs.append({"path": outp, "dur": slot, "fade": _fade_seconds(c.get("transition_out")),
                     "note": c.get("narrative_note", ""), "shot": c.get("shot_id"),
                     "src_in": fs, "src_dur": src_dur})
        timeline.append({"src_in": fs, "dur": src_dur, "tl": t0, "shot": c.get("shot_id"),
                         "section": c.get("section", ""), "transition": c.get("transition_out")})

    total = sum(x["dur"] for x in segs) - sum(
        min(x["fade"], x["dur"] * 0.4) for x in segs[:-1])
    print(f"      渲染 {len(segs)} 个片段 → 时间轴 {total:.1f}s")

    # ---- build the transition chain
    inputs = []
    for x in segs:
        inputs += ["-i", x["path"]]
    parts, prev, acc = [], "[0:v]", segs[0]["dur"]
    for i in range(1, len(segs)):
        fade = min(segs[i - 1]["fade"], segs[i - 1]["dur"] * 0.4, segs[i]["dur"] * 0.4)
        lbl = f"[vx{i}]"
        if fade > 0.04:
            parts.append(f"{prev}[{i}:v]xfade=transition=fade:duration={fade:.3f}"
                         f":offset={max(0.0, acc - fade):.3f}{lbl}")
            acc = acc + segs[i]["dur"] - fade
        else:
            parts.append(f"{prev}[{i}:v]concat=n=2:v=1:a=0{lbl}")
            acc += segs[i]["dur"]
        prev = lbl
    fg = ";".join(parts)
    silent = os.path.join(WORK, "clips_silent.mp4")
    cmd = ["ffmpeg", "-y", "-v", "error", *inputs,
           "-filter_complex", fg, "-map", prev, *enc_args,
           "-pix_fmt", "yuv420p", "-r", str(fps), silent]
    r = sh(cmd)
    if r.returncode != 0:
        die("拼接失败")
    print(f"      拼接完成 {probe_duration(silent):.1f}s")

    if remap_subs:
        edl = {"cuts": timeline, "blueprint": []}
        remap_ass(remap_subs, edl, out="clips_subs.ass", width=width, height=height,
                  fontsize=sub_fontsize)
        vfile = os.path.join(WORK, "clips_v.mp4")
        r = sh(["ffmpeg", "-y", "-v", "error", "-i", silent,
                "-vf", f"subtitles={os.path.join(WORK, 'clips_subs.ass')}",
                *enc_args, "-pix_fmt", "yuv420p", vfile])
        if r.returncode != 0:
            die("字幕烧制失败")
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
            "-b:a", "192k", "-shortest", out])
    if r.returncode != 0:
        die("音视频合成失败")
    print(f">> {out}  {probe_duration(out):.1f}s  "
          f"{os.path.getsize(out)/1048576:.1f} MB  {len(segs)} 个片段")
    save_json("clips_timeline.json",
              {"clips": timeline, "segments": [{k: v for k, v in x.items() if k != 'path'}
                                               for x in segs]})
    return out


'''
assert anchor in s
s = s.replace(anchor, fn + anchor, 1)

# ---- cli
s = s.replace('''    d = sub.add_parser("dialogue", help="只给已有镜头挂台词（不重算 CLIP）")''',
'''    c = sub.add_parser("render-clips", help="按显式镜头表渲染（不自动剪辑）")
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
    d = sub.add_parser("dialogue", help="只给已有镜头挂台词（不重算 CLIP）")''')

s = s.replace('''    elif a.cmd == "dialogue":''',
'''    elif a.cmd == "render-clips":
        render_clips(a.plan, a.song, a.out, a.width, a.height, a.fps, a.grade,
                     a.crf, a.remap_subs, a.sub_fontsize, a.hwaccel, a.encoder,
                     not a.no_fit)
    elif a.cmd == "dialogue":''')

open(P, "w").write(s)
print("added render-clips")
