# AMV 剪辑技能（Automatic Music Video）

> 让助理能把「一部长片 + 一首歌」变成卡拍点的 MV，而不是只会说"我不会剪视频"。
> 底层是 `edit.py`；技能层负责**什么时候用哪条路径、哪里必须停下来问人**。

## 0. 能力边界（先看这条）

| 能做 | 不能 / 必须先问 |
|---|---|
| 切镜头、按节拍排切点、转场、调色、合音轨 | 替你判断"哪段剧情该配哪句歌词"的审美终裁 |
| CLIP 语义检索（"黑灰中落泪的机械少女"） | 识别具体角色姓名（CLIP 不认人名，只认画面特征） |
| 歌词强制对齐（Whisper）并生成竖排三语字幕 | 翻译歌词（要做，但需人确认译文符合设定） |
| 导出 Premiere/FCP XML 供继续手改 | 源片版权合法性判断 |

**铁律**：涉及**成片交付**时，必须让用户看过抽帧/采样再定稿；不要只报"已完成"。

## 1. 三条路径，按需求选

| 场景 | 用什么 | 命令 |
|---|---|---|
| 从零做一支 | 自动规划 | `edit.py analyze` → `plan` → `render` |
| 已有镜头表（人给的） | 照单执行 | `edit.py render-clips plan.json song --quotes --lyrics` |
| 用户在 PR 里改完回传 XML | 重建 | `tools/render_v22.py`（注意 in/out 偏移，见 README §4.7） |

## 2. 必须遵守的技术约定

1. **先分析再动手**：`analyze` 产出 `shots.json/beats.json/index.npz`，后续全部依赖它。
2. **代理只用于检测**：`--detect-on proxy.mp4` 提速 5 倍，渲染仍用原片。
3. **不要整体拉伸时间轴**：把转场损耗摊进每个片段的槽位（README §4.2）。
4. **片段缓存加内容哈希**：否则改镜头表不会生效（README §4.3）。
5. **字幕提前量 = 淡入时长**：淡入完成的那刻正好是人声起点。
6. **透明字幕用 alphamerge**，不要 colorkey（会留黑边，README §4.6）。
7. **交付前必做抽帧核对**：字幕是否闪、是否黑帧、是否跨界碎切。

## 3. 常见故障对照

| 现象 | 先查 |
|---|---|
| 字幕一闪而过 | 该句时长 < 1.5s，Whisper 把整句挤到开头；延到下一句之前 |
| 某段黑屏 | 片段的 in/out 是否相对库文件（漏加偏移） |
| 画面比音乐慢 | 是否用了整体 `setpts` 拉伸（应改槽位） |
| 改了镜头表没变化 | 片段缓存没失效（缺内容哈希） |
| 字幕有黑边 | 用了 colorkey；改 alphamerge |
| 竖排文字横躺 | `，、` 没换空格 |
| 英文竖排读不动 | CJK 堆字 / 拉丁 `\frz270` 要分开处理 |

## 4. 交付物清单

一次完整的 MV 交付应包含：

- [ ] `out/final_*.mp4` 成片
- [ ] `examples/plan_final.json` 镜头表（可复现）
- [ ] `*.ass` 字幕源（叙事 + 歌词）
- [ ] `premiere_import.xml`（FCP7 XML，供手改）
- [ ] 抽帧核对图（证明字幕/黑帧/碎切都检查过）
- [ ] 已知局限（哪些地方是估的、哪些没验证）

## 5. 依赖

```
ffmpeg (含 libass)  PySceneDetect  opencv  open_clip  librosa
stable-ts + faster-whisper (large-v3)  PIL
audio-separator (人声分离，可选)  numpy
```

## 6. 相关

- 完整说明与设计取舍：[README.md](README.md)
- 本项目的成片字幕与镜头表：[docs/](docs/)、[examples/](examples/)
