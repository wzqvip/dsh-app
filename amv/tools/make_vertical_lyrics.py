#!/usr/bin/env python3
"""Vertical lyric overlay: CJK stacks per character, Latin rotates 90 degrees.

Rules from the user:
  * Chinese and Japanese lines must stay ONE unbroken column - shrink the font
    instead of splitting the line.
  * English reads badly stacked letter-by-letter, so lay it out horizontally and
    rotate the whole line 90 degrees clockwise.

For rotated text \frz270 spins the line around its anchor, so the anchor has to sit
half a text-width down from the top or the line hangs off the frame. PIL measures
that width with the very same font, which is far more reliable than guessing.
"""
import json
import sys

from PIL import ImageFont

FONT = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc"

W, H = 1920, 1080
RIGHT_X = 1836          # centre of the rightmost column (rotated latin centre line)
TOP_Y = 92
BOT_Y = 1012
MAX_FS = 46
MIN_FS = 20

# Whisper anchors a line at the first audible syllable, and the 280 ms fade made it
# read as late. Lead the captions so the text is already on screen when the singer
# starts, and keep it up a little past the last syllable.
# 淡入结束的那一刻正好是人声起点：所以提前量 = 淡入时长
FADE_IN_MS = 300
FADE_OUT_MS = 300
LEAD_S = FADE_IN_MS / 1000.0
TAIL_S = 0.10

PINK = "&H00E6D6F8"        # 日/英：淡粉
ROSE = "&H00704A8C"
GLOW = "&H00402A50"
VIOLET = "&H00FFB4F0"      # 龙语：淡紫霓虹（BGR）
CN_SOFT = "&H00DEC8E8"     # 中文：银紫

# 这些音节只出现在远古龙语吟唱里
DRAGON_KEYS = ("Do-vah", "Al-du-in", "A-la-mi-ra", "E-len-si-la",
               "A-le-na-ri", "kyu-ri-a-no", "o-ra-na-the", "o-va-ri-on",
               "thu-um", "va-ri")

HEADER = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: JP,Noto Serif CJK JP,44,{PINK},&H000000FF,{ROSE},{GLOW},0,0,0,0,100,100,1,0,1,1.7,2.2,8,0,0,0,1
Style: DR,Noto Serif CJK JP,44,{VIOLET},&H000000FF,&H006A1B9A,{GLOW},0,-1,0,0,100,100,2,0,1,2.0,2.6,8,0,0,0,1
Style: CN,Noto Serif CJK SC,42,{CN_SOFT},&H000000FF,{ROSE},{GLOW},0,0,0,0,100,100,1,0,1,1.7,2.2,8,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

_font_cache = {}


def font(size):
    if size not in _font_cache:
        _font_cache[size] = ImageFont.truetype(FONT, size)
    return _font_cache[size]


def ts(t):
    t = max(0.0, t)
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def is_latin(text):
    """True when the line is basically latin script (nothing to stack upright)."""
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return False
    latin = sum(1 for c in letters if ord(c) < 0x2500)
    return latin / len(letters) > 0.6


def fit_stacked(text, style):
    """Single unbroken column: shrink until every character fits vertically."""
    n = len(text)
    avail = BOT_Y - TOP_Y
    fs = int(min(MAX_FS, avail / max(n, 1) / 1.42))
    fs = max(MIN_FS, fs)
    return fs


def fit_rotated(text):
    """Rotated line: shrink until its width fits the available height."""
    for fs in range(MAX_FS, MIN_FS - 1, -1):
        if font(fs).getlength(text) <= (BOT_Y - TOP_Y):
            return fs
    return MIN_FS


def schedule(events, total=184.0):
    """Advance every caption, then fit the tail without delaying the next line.

    Doing it per-line in one pass let TAIL push each following line LATER, which is
    the opposite of what a lead is for.
    """
    starts = [max(0.0, e["ws"] - LEAD_S) for e in events]
    for i, e in enumerate(events):
        nxt = starts[i + 1] if i + 1 < len(events) else total
        end = max(e["we"] + TAIL_S, starts[i] + 1.0)
        e["_start"] = starts[i]
        e["_end"] = max(starts[i] + 0.5, min(end, nxt - 0.03))
    return events


def build(events, out="/home/taco/edit/work/lyrics_vertical.ass"):
    lines = []
    prev_end = 0.0
    events = schedule(events)
    for e in events:
        # 竖排里逗号/顿号会横躺或偏右，直接用空格换掉更干净
        def clean_v(t):
            for ch in "，、,;；:：":
                t = t.replace(ch, " ")
            return " ".join(t.split())
        orig, cn = clean_v(e["orig"]), clean_v(e.get("cn") or "")
        cols = []

        if is_latin(orig):
            fs = fit_rotated(orig)
            width = font(fs).getlength(orig)
            # libass renders this face at ~0.739 of PIL's measured advance width
            # (measured: 484/656, 551/747, 599/807), so scale before centring or the
            # line hangs off the frame
            y = TOP_Y + width * 0.739 / 2.0
            cols.append(("rot", orig, fs, y))
        else:
            fs = fit_stacked(orig, "JP")
            cols.append(("stack", orig, fs, TOP_Y))

        if cn:
            fs = fit_stacked(cn, "CN")
            cols.append(("stack", cn, fs, TOP_Y))

        e_start = e["_start"]
        e_end = e["_end"]

        x = RIGHT_X
        for kind, text, fs, y in cols:
            if kind == "rot":
                body = text
                fx = (f"{{\\an8\\pos({x:.0f},{y:.0f})\\fs{fs}\\frz270"
                      f"\\fad({FADE_IN_MS},{FADE_OUT_MS})"
                      f"\\blur0.5\\bord1.7\\shad2.2}}")
                pitch = fs * 1.55
            else:
                body = "\\N".join(text)
                fx = (f"{{\\an8\\pos({x:.0f},{TOP_Y})\\fs{fs}"
                      f"\\fad({FADE_IN_MS},{FADE_OUT_MS})"
                      f"\\blur0.5\\bord1.7\\shad2.2}}")
                pitch = fs * 1.06
            if kind == "stack" and text == cn:
                style = "CN"
            elif kind == "rot" and any(k in text for k in DRAGON_KEYS):
                style = "DR"          # 龙语行单独走高亮淡紫
            else:
                style = "JP"
            lines.append(f"Dialogue: 0,{ts(e_start)},{ts(e_end)},{style},,0,0,0,,{fx}{body}")
            x -= pitch

    open(out, "w", encoding="utf-8").write(HEADER + "\n".join(lines) + "\n")
    print(f">> {out}  {len(lines)} 列  {len(events)} 句")


if __name__ == "__main__":
    ev = json.load(open("/home/taco/edit/work/lyrics_final.json"))
    build(ev)
