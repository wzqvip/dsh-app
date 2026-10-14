# -*- coding: utf-8 -*-
"""WindowBox 的蜂窝变体 —— 另存为独立的 `WindowBoxHex`。

    python fusion/bridge_client.py exec --file <本文件>

用户要求：

    第一圈（靠窗那半）不要，那里实心
    从第二圈开始、按同样间距一直排到尾部
    挂耳不要
    单独存成 WindowBoxHex（不动原来的 WindowBox）

# 实现方式：给基础脚本套一层参数

几何只有一份（`noorio_window_box.py`），变体只差三件事 —— 哪几圈打蜂窝、
要不要挂耳、存成哪个文件。所以这里设 `WINDOWBOX_OVERRIDES` 再 exec 基础脚本。
⚠️ 覆盖必须在 exec **之前**写进 globals：基础脚本第一件事就是读它。

# 蜂窝行距

外接圆 R=5 的正六边形，标准蜂窝节距是：
    方位向孔距 = √3R ≈ 11.7mm   -> 每圈 30 孔（r=55.5 处）
    轴向行距   = 1.5R ≈ 10mm    -> y = 14 / 24 / 34 三圈
孔间留约 3mm 筋。这铺满了圆柱中段（y 约 9..39），只在前端
（法兰 + 过渡段，y<9）和赤道附近（y>39，紧接着就是半球段）留实心。

⚠️ 半球尾部仍然做不了：本版本 Fusion 没有任何构造能给出球面切平面
（六条路的实测结果见 noorio_window_box.py 的文件头注释）。
要打通尾部必须把外壳尾部由半球改成圆锥。
"""

import io
import os

# 基础脚本（本文件只是换一组参数去 exec 它，几何只有一份）。
# ⚠️ Fusion 里没有 __file__，所以只能写绝对路径；用候选列表，挪目录后不会静默失效。
_CANDIDATES = [
    r"C:\Users\WANGZ\Documents\GitHub\dsh-app\fusion\noorio-b310\noorio_window_box.py",
    r"C:\Users\WANGZ\Documents\GitHub\dsh-app\tools\fusion-bridge\examples\noorio_window_box.py",
]
BASE = next((p for p in _CANDIDATES if os.path.exists(p)), _CANDIDATES[0])

WINDOWBOX_OVERRIDES = {
    "file_name": "WindowBoxHex",
    # 铺满圆柱段。真正的蜂窝节距 —— 外接圆 R=5 时
    #   方位向孔距 = √3R ≈ 11.7mm -> 每圈 30 孔
    #   轴向行距   = 1.5R ≈ 10mm   -> y = 12 / 24 / 36 三圈（覆盖 y 约 7..41）
    # 孔间留约 3mm 筋，行间错开半格。实测三圈全部 100% 穿透，共 90 个真通孔。
    "hex_row_y": [12.0, 24.0, 36.0],
    "hex_pitch": 11.7,
    "groove_y": [18.0, 30.0],
    # ⚠️ 两道 0.3mm 浅环槽，把外柱面分成 10..20 / 20..30 / 30..45 三段。
    #    为什么必须分段：切平面只在**它原点以下**的半边有效，而 setByTangent 的
    #    原点落在该段柱面的中高处。不分段的话整根柱面（中高 27.5）只有少数高度
    #    能打孔。分段后各段中点 13.8 / 24.0 / 37.6，三圈 12 / 24 / 36 都在其下方。
    #    槽 0.3mm 深，落在两圈孔之间的缝里，基本看不见。
    "hook": False,
}

exec(compile(io.open(BASE, encoding="utf-8").read(), BASE, "exec"))

