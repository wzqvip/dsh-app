import json, re, sys
import stable_whisper

raw = open("lyrics.txt", encoding="utf-8").read()
lines, sec = [], None
sections = []
for ln in raw.splitlines():
    ln = ln.strip()
    if not ln: continue
    m = re.match(r"^\[(\w+)\]$", ln)
    if m:
        sec = m.group(1); continue
    # 去掉括号里的假名注音，那不是唱出来的
    t = re.sub(r"[（(][^）)]*[）)]", "", ln).strip()
    if t:
        lines.append(t); sections.append(sec)
print(f"歌词 {len(lines)} 行")
text = "\n".join(lines)
open("lyrics_flat.txt","w").write(text)

print("加载模型…")
model = stable_whisper.load_faster_whisper("large-v3", device="cuda", compute_type="float16")
print("对齐中…")
res = model.align("/home/taco/gen/audio/song_1794608919.flac", text, language="ja")
res.save_as_json("aligned.json")

segs = res.segments
print(f"对齐出 {len(segs)} 段")
for i, s in enumerate(segs):
    print(f"  {s.start:7.2f}-{s.end:7.2f}  {s.text.strip()[:52]}")
