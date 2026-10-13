# -*- coding: utf-8 -*-
"""WindowBox 的蜂窝变体 —— 另存为独立的 `WindowBoxHex`。

    python tools/fusion-bridge/bridge_client.py exec --file <本文件>

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

沿用基础脚本的 14mm 间距，从 y=28（原来的第二圈）起：28 / 42 / 56 / 70 / 84。
每行孔数由该处外半径自动算（圆周孔距锁在 14.4mm），行间错开半格。
y=84 那圈是安全的：六边形沿球面最多伸到 y≈87.5，仍在 Ø60 收口孔外缘
（y=91.69）之前，且半径 35.7 > 孔半径 30。
"""

import io

BASE = r"C:\Users\WANGZ\Documents\GitHub\dsh-app\tools\fusion-bridge\examples\noorio_window_box.py"

WINDOWBOX_OVERRIDES = {
    "file_name": "WindowBoxHex",
    "hex_row_y": [28.0, 42.0, 56.0, 70.0, 84.0],
    "hook": False,
}

exec(compile(io.open(BASE, encoding="utf-8").read(), BASE, "exec"))
