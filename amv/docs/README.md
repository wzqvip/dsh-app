# NGNL Zero AMV — 全 AI 剪辑工作区

《游戏人生 零》× `song_1794608919.flac` 的音乐影像，**2:57 收束**。
成片：`out/ngnl_final.mp4`（177.0s / 1920×1080 / 24fps）

---

## 目录

```
edit.py                 主程序：analyze / search / plan / render / render-clips / dialogue
tools/                  一次性脚本（对齐、导出、歌词排版）
docs/                   本文件、成片用的字幕源文件
source/                 素材（不参与构建）
  footage/ngnl_zero.mkv       原片 5.8G
  footage/ngnl_proxy_gpu.mp4  360p 代理，只用于镜头检测
  subs/original.ass           原片中文对白
  subs/uha.ass / clean_*.ass  UHA-WINGS 特效轨与清洗版
  lyrics.txt / lyrics_2ch.lrc 歌词与双语 LRC
work/                   中间产物（可重建）
  beats.json              节拍 + 能量 + 素材路径
  shots.json              1478 个镜头（含 luma/detail/usable/台词）
  index.npz               CLIP 向量
  film_map.json           内容地图（按分钟）
  lyrics_final.json       28 句歌词的实测时间
  lyrics_vertical.ass     竖排三语歌词
  quotes.ass              叙事字幕（2 字卡 + 18 独白）
  plan_v6.json            成片用的镜头表
out/                    成片
export/                 给外部模型用的镜头表（shots.json / timeline.md）
```

---

## 重新出片

```bash
cd ~/edit

# 直接用现成的镜头表 + 字幕
~/gen/.venv/bin/python edit.py render-clips work/plan_v6.json \
  ~/gen/audio/song_1794608919.flac \
  --out out/ngnl_final.mp4 \
  --quotes work/quotes.ass --lyrics work/lyrics_vertical.ass \
  --end 177 --hwaccel cuda
```

约 2.5 分钟（片段缓存存在 `work/clipparts/`，删了会重渲）。

## 从零重建

```bash
# 1. 分析：节拍 + 镜头 + CLIP 索引（106 分钟片约 4 分钟）
~/gen/.venv/bin/python edit.py analyze \
  source/footage/ngnl_zero.mkv ~/gen/audio/song_1794608919.flac \
  --detect-on source/footage/ngnl_proxy_gpu.mp4 --subs source/subs/clean_bdrip.ass

# 2. 语义找镜头
~/gen/.venv/bin/python edit.py search "girl with mechanical wings crying" --top 5

# 3. 自动规划（可选，LLM 定故事结构）
~/gen/.venv/bin/python edit.py plan --backend local

# 4. 歌词对齐（需要 stable-ts）
~/gen/.venv/bin/python tools/align_lyrics.py
~/gen/.venv/bin/python tools/make_vertical_lyrics.py
```

---

## 关键参数

| 位置 | 参数 | 当前值 | 说明 |
|---|---|---|---|
| `tools/make_vertical_lyrics.py` | `FADE_IN_MS` | 300 | 淡入时长 |
| 同上 | `LEAD_S` | = FADE_IN_MS/1000 | 提前量等于淡入时长，淡入完成的那刻正好是人声起点 |
| 同上 | `RIGHT_X` / `COL_PITCH` | 1836 / 50 | 右侧竖排列位置与间距 |
| 同上 | `PINK` / `VIOLET` / `CN_SOFT` | | 日英淡粉 / 龙语淡紫 / 中文银紫 |
| `edit.py` `render_clips` | `end_s` | 177 | 只用歌曲前 N 秒 |

**语速微调**：想让歌词更早出现就调大 `LEAD_S`，但淡入完成时刻会随之提前。

---

## 已解决的关键问题（改之前先看）

1. **画面与歌曲漂移** — 转场重叠会让拼好的片短 5%，早期用整体 `setpts` 拉伸补齐，导致画面越到后面越慢。现在改为**渲染前把余量摊进每个片段**，画面和歌锁死。
2. **片段缓存失效** — 复用时只比对时长，改镜头表但时长不变会静默沿用旧片段。现在文件名带源区间哈希。
3. **跨镜头闪切** — 源区间跨过镜头边界时，末端可能只剩 0.2s。现在按「最大化最短分段」选窗口，每段 ≥1.5s。
4. **片名 Logo 乱入** — 片源 268–274s 是标题动画，藏在同一镜头里。第 2 段已避开。
5. **竖排标点横躺** — 竖排里的 `，、` 全部换空格。
6. **英文竖排难读** — 英文行横排后 `\frz270` 旋转；锚点用 PIL 量宽度 ×0.739 补偿（libass 实际渲染宽度约为 PIL 的 73.9%）。

---

## 已知局限

- 副歌（74–103s）画面偏静，能量最猛处是对话镜头
- `A-le-na-ri` 一句占 128.6–153.1s（真实超长拖音），竖排停在同一屏较久
- 封面图 `watermarked_img_...jpg` 始终未提供，片头用白虚空代替
- 字幕为手工时间轴，若某句与画面错位需手动改 `quotes.ass`
