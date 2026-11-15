#!/usr/bin/env python3
"""Export the cut as Final Cut Pro 7 XML (xmeml), which Premiere Pro imports.

Why xmeml: Premiere reads FCP7 XML natively and rebuilds a real sequence with
per-clip in/out points, so the edit can be adjusted shot by shot instead of
poking at a flattened mp4.

The rendered version uses 0.5 s crossfades, which makes clips overlap. Premiere
would need a transition item for each, which is fragile, so this export writes the
same cut points with the overlap folded in: clips butt end to end at exactly the
same boundaries, and the user can drop dissolves back in if they want them.
"""
import json
import os
import sys
import urllib.parse

PLAN = "/home/taco/edit/work/plan_v9.json"
OUT = "/home/taco/edit/export/ngnl_amv_v20.xml"
FPS = 24
SONG_DUR = 178.0

VIDEO_WIN = ("D:/bitcomet download/[VCB-Studio] No Game No Life Zero [Ma10p_1080p]/"
             "[VCB-Studio] No Game No Life Zero [Ma10p_1080p][x265_flac].mkv")
AUDIO_WIN = "D:/ngnl_amv/song_1794608919.flac"


def fade_seconds(spec):
    import re
    if not spec:
        return 0.0
    spec = str(spec).lower()
    if spec.startswith("cut"):
        return 0.0
    m = re.search(r"([0-9.]+)\s*s?$", spec)
    return max(0.0, min(1.5, float(m.group(1)) if m else 0.5))


def f(sec):
    return int(round(sec * FPS))


def url(path):
    return "file://localhost/" + urllib.parse.quote(path, safe="/:")


def main():
    plan = json.load(open(PLAN))
    clips = plan["clips"]

    slots = [c["music_end_s"] - c["music_start_s"] for c in clips]
    fades = [fade_seconds(c.get("transition_out")) for c in clips]
    loss = sum(min(fades[j], slots[j] * 0.4, slots[j + 1] * 0.4)
               for j in range(len(clips) - 1))
    mult = SONG_DUR / max(0.1, sum(slots) - loss)

    # timeline positions exactly as the renderer builds them
    starts, durs = [], []
    t = 0.0
    for i, s in enumerate(slots):
        starts.append(t)
        durs.append(s * mult)
        if i < len(clips) - 1:
            t += s * mult - min(fades[i], durs[i] * 0.4, slots[i + 1] * mult * 0.4)

    rows = []
    for i, c in enumerate(clips):
        begin = starts[i]
        end = starts[i + 1] if i + 1 < len(clips) else SONG_DUR
        xml_dur = max(0.1, end - begin)                 # no overlap
        src_in = c["film_start_s"]
        src_span = c["film_end_s"] - c["film_start_s"]
        scale = src_span / durs[i]                       # source seconds per timeline second
        src_out = src_in + xml_dur * scale
        rows.append({"i": i, "begin": begin, "end": end, "dur": xml_dur,
                     "src_in": src_in, "src_out": src_out, "span": src_span,
                     "note": c.get("narrative_note", "")})

    total_frames = f(SONG_DUR)
    clip_items = []
    for r in rows:
        clip_items.append(f"""      <clipitem id="clipitem-{r['i']+1}">
        <name>{r['i']+1:02d} {r['note'][:28]}</name>
        <duration>{f(r['span'])}</duration>
        <rate><timebase>{FPS}</timebase><ntsc>FALSE</ntsc></rate>
        <start>{f(r['begin'])}</start>
        <end>{f(r['end'])}</end>
        <in>{f(r['src_in'])}</in>
        <out>{f(r['src_out'])}</out>
        <file id="file-1">
          <name>ngnl_zero.mkv</name>
          <pathurl>{url(VIDEO_WIN)}</pathurl>
          <rate><timebase>{FPS}</timebase><ntsc>FALSE</ntsc></rate>
          <duration>{f(6360.33)}</duration>
          <media>
            <video>
              <samplecharacteristics>
                <rate><timebase>{FPS}</timebase><ntsc>FALSE</ntsc></rate>
                <width>1920</width><height>1080</height>
                <anamorphic>FALSE</anamorphic>
                <pixelaspectratio>square</pixelaspectratio>
                <fielddominance>none</fielddominance>
              </samplecharacteristics>
            </video>
            <audio>
              <samplecharacteristics>
                <depth>16</depth><samplerate>48000</samplerate>
              </samplecharacteristics>
              <channelcount>2</channelcount>
            </audio>
          </media>
        </file>
      </clipitem>""")

    markers = []
    for r in rows:
        note = (r["note"] or "").replace("&", "&amp;").replace("<", "&lt;")
        markers.append(f"    <marker><name>cut {r['i']+1:02d}</name>"
                       f"<comment>{note}</comment>"
                       f"<in>{f(r['begin'])}</in><out>{f(r['begin'])}</out></marker>")

    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>NGNL Zero AMV v20 (178s)</name>
    <duration>{total_frames}</duration>
    <rate><timebase>{FPS}</timebase><ntsc>FALSE</ntsc></rate>
{chr(10).join(markers)}
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <rate><timebase>{FPS}</timebase><ntsc>FALSE</ntsc></rate>
            <width>1920</width>
            <height>1080</height>
            <anamorphic>FALSE</anamorphic>
            <pixelaspectratio>square</pixelaspectratio>
            <fielddominance>none</fielddominance>
          </samplecharacteristics>
        </format>
        <track>
{chr(10).join(clip_items)}
        </track>
      </video>
      <audio>
        <format>
          <samplecharacteristics>
            <depth>16</depth><samplerate>48000</samplerate>
          </samplecharacteristics>
        </format>
        <track>
          <clipitem id="clipitem-song">
            <name>song_1794608919</name>
            <duration>{f(SONG_DUR)}</duration>
            <rate><timebase>{FPS}</timebase><ntsc>FALSE</ntsc></rate>
            <start>0</start>
            <end>{f(SONG_DUR)}</end>
            <in>0</in>
            <out>{f(SONG_DUR)}</out>
            <file id="file-2">
              <name>song_1794608919.flac</name>
              <pathurl>{url(AUDIO_WIN)}</pathurl>
              <rate><timebase>{FPS}</timebase><ntsc>FALSE</ntsc></rate>
              <duration>{f(SONG_DUR)}</duration>
              <media>
                <audio>
                  <samplecharacteristics>
                    <depth>16</depth><samplerate>48000</samplerate>
                  </samplecharacteristics>
                  <channelcount>2</channelcount>
                </audio>
              </media>
            </file>
          </clipitem>
        </track>
      </audio>
    </media>
  </sequence>
</xmeml>
"""
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8").write(xml)
    print(f">> {OUT}")
    print(f"   {len(rows)} 个片段  {total_frames} 帧 @ {FPS}fps = {SONG_DUR}s  mult={mult:.4f}")
    for r in rows[:4] + rows[-2:]:
        print(f"   {r['i']+1:02d} {r['begin']:7.2f}-{r['end']:7.2f}s  "
              f"源 {r['src_in']:7.1f}-{r['src_out']:7.1f}s")


if __name__ == "__main__":
    main()
