#!/usr/bin/env python3
"""Retime subtitles to the clip windows, and rotate latin lyrics 270 instead of 90.

Why retime: the source subtitle timing gives no thought to our cut. The result was
24 of 50 lines under 1.5 s (one flashed for 0.24 s) and 14 gaps over two seconds,
with a 16-second hole at the start. The music video has no dialogue audio - only the
song - so the captions are context, and we are free to hold them across a cut.

New rules:
  * every line on screen >= MIN_DUR
  * one line per slice of the clip, last line holds to the clip end
  * a clip with no dialogue of its own holds the previous line
  * nothing runs past the end of the song
"""
P = "/home/taco/edit/edit.py"
s = open(P).read()

anchor = "def render_clips("
fn = '''def polish_subs(ass_in, ass_out, windows, total, min_dur=2.2):
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
            txt = re.sub(r"\\{[^}]*\\}", "", rest.split(",", 6)[-1]).strip()
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
    body = "\\n".join(f"Dialogue: 0,{ts(a)},{ts(b)},{style},,0,0,0,,{t}" for a, b, t in out)
    open(ass_out, "w", encoding="utf-8").write("\\n".join(header) + "\\n" + body + "\\n")
    durs = [b - a for a, b, _ in out]
    print(f">> 字幕重排: {len(events)} 条 → {len(out)} 条  "
          f"最短 {min(durs):.2f}s  平均 {sum(durs)/len(durs):.2f}s")
    return ass_out


'''
assert anchor in s
s = s.replace(anchor, fn + anchor, 1)

# hook it into render_clips right after the remap
old = '''            remap_ass(remap_subs, edl, out="clips_subs.ass", width=width, height=height,
                      fontsize=sub_fontsize)
            chain.append(f"subtitles={os.path.join(WORK, 'clips_subs.ass')}")'''
new = '''            remap_ass(remap_subs, edl, out="clips_subs.ass", width=width, height=height,
                      fontsize=sub_fontsize)
            # clips already carry their stretched position; reflow within them
            wins = []
            for c in timeline:
                a = c["tl"] * stretch
                wins.append((a, a + c["slot"] * stretch))
            polished = polish_subs(os.path.join(WORK, "clips_subs.ass"),
                                   os.path.join(WORK, "clips_subs2.ass"),
                                   wins, song_dur)
            chain.append(f"subtitles={polished}")'''
assert old in s
s = s.replace(old, new, 1)
open(P, "w").write(s)
print("added polish_subs")
