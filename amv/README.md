# AMV —— 全自动音乐影像剪辑

把一部长片 + 一首歌，变成一支卡着节拍、按剧情推进、带竖排歌词和叙事字幕的 MV。
不需要剪辑软件，一条命令出片；也能导出到 Premiere 继续手改。

产出实例：《游戏人生 零》×《Sparks in the Endless Ash》，178 秒 / 1080p24。

---

## 1. 它做什么

```
原片 ──┬─ 镜头切分（PySceneDetect）+ 质量筛（黑帧/纯色/过短）
       ├─ CLIP 视觉标签（每个镜头"画了什么"）
       ├─ 字幕对齐（每个镜头"说了什么"）
       └─ 内容地图（按分钟聚合概念 + 台词）
                    ↓
歌曲 ──┬─ 节拍 / 能量 / 段落
       └─ 歌词强制对齐（stable-ts + Whisper）
                    ↓
        ┌───────────┴───────────┐
   自动规划（LLM）          显式镜头表
   定故事结构                照单执行
        └───────────┬───────────┘
                    ↓
        逐段渲染 → 转场拼接 → 烧字幕 → 合音轨
```

## 2. 子命令

| 命令 | 作用 |
|---|---|
| `analyze` | 节拍 + 镜头 + CLIP 索引 + 台词挂载（106 分钟片约 4 分钟） |
| `search "…"` | 自然语言找镜头（CLIP 文本→图像） |
| `plan` | LLM 定故事结构 → 展开成卡拍点的 EDL |
| `render` | 按 EDL 逐段切 + 转场 + 字幕 + 合轨 |
| `render-clips` | 按显式镜头表渲染（支持每条独立速度、转场、`--end` 截断） |
| `dialogue` | 只给已有镜头挂台词（不重算 CLIP） |
| `ass` | 生成 ASS 字幕 |

## 3. 快速开始

```bash
# 1. 分析（--detect-on 用 360p 代理，快 5 倍）
python edit.py analyze source/footage/movie.mkv song.flac \
    --detect-on source/footage/proxy.mp4 --subs source/subs/chs.ass

# 2. 找镜头
python edit.py search "girl with mechanical wings crying" --top 5

# 3. 规划（本地 EXL3 或 --backend deepseek）
python edit.py plan --backend local

# 4. 出片
python edit.py render --out out/final.mp4 --remap-subs source/subs/chs.ass --hwaccel cuda

# 5. 或者按镜头表精确渲染
python edit.py render-clips examples/plan_final.json song.flac \
    --out out/final.mp4 --quotes examples/subtitles_narrative.ass \
    --lyrics examples/subtitles_lyrics.ass --end 178 --hwaccel cuda
```

## 4. 关键设计决策

### 4.1 LLM 只定结构，代码负责卡点

第一版让 LLM 逐条输出切点，**失败**：4 分钟歌要 200+ 条，模型跑偏或 JSON 截断。
现在 LLM 只回 5 行「每段平均切多快、用哪个片源区间」，代码按节拍网格展开。
**效果：37 秒且常常失败 → 4 秒稳定，卡点中位误差 0.3ms。**

### 4.2 片段预先放大，不要整体拉伸

转场重叠会让拼好的片短 5%。早期用 `setpts` 整体拉伸补齐，**画面越到后面越比音乐慢**，
结尾能差 9 秒，歌词也跟着漂。现在把余量摊进每个片段的槽位，画面与歌锁死。

### 4.3 片段缓存必须带内容哈希

复用片段只比对时长 → 改了镜头表但时长没变时，**静默沿用旧素材**。
文件名要带源区间 + 调色 + 分辨率的哈希。

### 4.4 每个片段限制在单镜头内，或保证跨界后每段 ≥1.5 秒

源区间跨过镜头边界时末端可能只剩 0.2 秒 → 观感是"闪一下"。
按「最大化最短分段」选窗口。

### 4.5 字幕竖排：CJK 堆字、拉丁旋转

libass 不支持 `@字体名` 的竖排模式。可行做法：
- **中文/日文**：每字一行（`\N` 分隔），按列长自适应字号，**整句不折列**
- **拉丁文**：整行横排后 `\frz270`，锚点按 `PIL 实测宽度 × 0.739` 下移半宽
- 竖排里的 `，、` 一律换空格，否则会横躺

### 4.6 透明覆盖层：用 alphamerge，不要 colorkey

`colorkey` 抠黑会把文字的深色阴影留下 → 亮背景上一圈黑边。
正确做法：文字渲在纯黑底上，**取亮度当 alpha**。

```bash
ffmpeg -f lavfi -i "color=black:s=1920x1080:r=24:d=DUR" \
  -filter_complex "[0:v]subtitles=x.ass,split=2[base][m];\
[m]format=gray[mask];[base]format=rgba[b2];[b2][mask]alphamerge[out]" \
  -map "[out]" -c:v qtrle -pix_fmt argb out.mov
```

### 4.7 引用外部片段时 in/out 是相对的

Premiere 导出的 XML 里，若片段引用的是**另一个 mp4**（不是原片），
`in/out` 是相对那个文件的偏移，必须加上文件自身的起点，否则取到完全无关的画面。

## 5. 参数表

| 位置 | 参数 | 说明 |
|---|---|---|
| `edit.py` | `WORK` | 中间产物目录（默认 `~/edit/work`） |
| `render_clips(end_s=)` | 截断长度 | 例如在乐句小结处收束 |
| `tools/make_vertical_lyrics.py` | `FADE_IN_MS` / `LEAD_S` | 提前量 = 淡入时长 → 淡入完成的那刻正好是人声起点 |
| 同上 | `RIGHT_X` / `COL_PITCH` | 右侧竖排列位置与间距 |
| 同上 | `PINK` / `VIOLET` / `CN_SOFT` | 日英淡粉 / 龙语淡紫 / 中文银紫 |
| `tools/export_xml.py` | 路径常量 | 导出 Premiere 可导入的 FCP7 XML |

## 6. 工具

| 脚本 | 作用 |
|---|---|
| `tools/align_lyrics.py` | stable-ts + Whisper 强制对齐歌词（用 large-v3） |
| `tools/make_vertical_lyrics.py` | 生成竖排三语歌词 ASS |
| `tools/split_overlays.py` | 把覆盖层按句拆成独立片段（便于在 PR 里调长度） |
| `tools/export_shots.py` | 导出镜头表（JSON + 可读时间线）给外部模型 |
| `tools/export_xml.py` | 导出 Premiere 可导入的 FCP7 XML |
| `tools/render_v22.py` | 按用户回传的 Premiere XML 重建成片 |
| `tools/patch-history/` | 历史补丁，仅作演进记录，不要运行 |

## 7. 踩过的坑（都已在代码里处理）

1. **JSON 修复要用栈闭合括号** —— 模型会输出 `}'`（缺 `]`），补在末尾是无效的
2. **推理模型要关 thinking** —— 否则 token 全烧在思考上，JSON 被截断（37s → 4s）
3. **CLIP 概念要按时间轴归一化** —— 否则整片每个分钟都标成 "hand/battle/smoke"
4. **`__pycache__` 与中间视频不要进仓库**
5. **`-ss` 放在 `-i` 前会让字幕滤镜看到 0 秒** —— 用 `-copyts` 或把 `-ss` 放后面
6. **ffmpeg `segment`/`concat` 混合会改时间基** —— `xfade` 报 timebase 不匹配，需 `settb=AVTB`

## 8. 目录

```
amv/
├── edit.py                 主程序
├── tools/                  辅助脚本
│   └── patch-history/      历史补丁（勿运行）
├── docs/                   本项目的成片字幕与镜头表
└── examples/               可复用的样例
    ├── plan_final.json         25 段镜头表
    ├── subtitles_narrative.ass 20 条剧情独白
    ├── subtitles_lyrics.ass    28 句竖排三语歌词
    ├── lyrics_timed.json       歌词实测时间
    ├── premiere_import.xml     导给 Premiere 的 XML
    └── premiere_roundtrip.xml  Premiere 回传后修正的 XML
```
