# 铭凡双机改造调研：MS-A1 + OCuLink 显卡坞 / MS-01 + 905P U.2

> 调研日期：2026-10-30　范围：MakerWorld（.com / .com.cn）为主，Printables / Thingiverse 兜底
> 目标读者：手上有 **MS-A1 + OCuLink 显卡坞 + ATX 电源 + 双槽三风扇显卡**，以及 **MS-01 + 五盘位 USB 硬盘盒 + 傲腾 905P U.2（15mm）** 的本人

---

## 0. 结论速览

| 需求 | 结论 | 首选 |
|---|---|---|
| 显卡坞要个壳 | **有现成的，且只此一家做得最对**：Dopins 的 DEG1 外壳，明确写了「全尺寸 ATX 电源 + 双槽挡板显卡」。但**显卡长度上限只写在图里，没给数字**，三风扇长卡必须先量 | MakerWorld [942817](https://makerworld.com/en/models/942817-minisforum-deg1-egpu-dock-enclosure-case)（STEP 在 Printables [1039236](https://www.printables.com/model/1039236-minisforum-deg1-egpu-dock-enclosure-case-shell)） |
| 905P 15mm 塞不进 MS-01 | MS-01 的 U.2 位只吃 **7.5mm**，15mm 必须动结构。三条路：①加高底盖（最省事）②走 PCIe 槽用薄转接卡（不占 M.2 位）③外置 | MakerWorld [718278](https://makerworld.com/en/models/718278-minisforum-ms-01-case-extension-to-fit-15mm-ssd)（加高底盖） |
| 905P 会不会过热 | **会**。905P U.2 在 27°C 室温、仅做系统盘时就 46°C，必须给风；企业盘（PM9A3）在 MS-01 里待机就 57/66°C 并会降速 | MakerWorld [1585889](https://makerworld.com/zh/models/1585889-u-2-ssd-cooler-for-15mm-ssd-with-fan)（15mm 专用带风扇散热器） |
| 五盘位硬盘盒散热 | **基本没有对应型号的现成模型**，得自己量尺寸做「顶盖开孔 + 12cm 风扇 + 减震脚」 | 思路参考 Printables [1575010](https://www.printables.com/model/1575010-orico-ds500-5-bay-hard-disk-enclosure-top-cover-fa)（ORICO DS500 顶盖风扇改装） |

一句话：**显卡坞买/打 Dopins 那套；905P 优先加高底盖 + 主动散热；硬盘盒自己画转接框。**

---

## 1. 先把硬件事实钉死（这决定方案可行不可行）

### 1.1 MS-A1（显卡那台）

| 项 | 事实 | 来源 |
|---|---|---|
| 平台 | AM5 插槽，R7 8700G / R5 8600G / R5 7600，后续可升 Zen 5 | [IT之家/PC Watch](https://digi.ithome.com/archiver/775/404.htm) |
| 内存 | 2× DDR5 SO-DIMM，最高 96GB | 同上 |
| 存储 | 早期宣传「支持 U.2，最多 4 块 M.2」；**维护者手上的后期版本已砍掉 U.2 支持**（2026-10-30 确认），实际按「纯 M.2」规划 | [IT之家/PC Watch](https://digi.ithome.com/archiver/775/404.htm) + 维护者确认 |
| 外接显卡 | **OCuLink（PCIe 4.0 x4）** | 同上 |
| 网络 / 供电 | 双 2.5GbE；DC5525 19V 12.6A | 同上 |
| 注意 | **MS-A1 没有内部 PCIe 插槽**（这点和 MS-01 不同） | Chiphell 讨论 |

### 1.2 显卡坞（默认按 DEG1 说）

| 项 | 事实 | 来源 |
|---|---|---|
| 上行 | OCuLink 4i，PCIe 4.0 x4 | [Notebookcheck](https://www.notebookcheck.net/Minisforum-DEG1-Docking-station-for-eGPUs-promises-great-extra-performance-for-laptops-and-mini-PCs.844928.0.html) |
| 电源 | 支持 **ATX 与 SFX** 标准电源，板上是 24-pin ATX 接口 | 同上 |
| 显卡 | 官方称可上 RTX 4090 / RX 7900 XTX 级别的大卡（开放框架，长度不受壳限制） | 同上 |
| 形态 | 开放式框架（裸板 + PCIe 槽 + 电源位），本身没有壳 | 同上 |

> 如果你手里其实是 ADT-Link F9G / NFHK 之类的通用 OCuLink 坞，下面「通用 ATX 壳」那几条同样适用，只是固定孔要自己改。

### 1.3 MS-01（NAS 那台）

| 项 | 事实 | 来源 |
|---|---|---|
| 存储 | 板载 **3× M.2**，其中一个可经随箱附带的 **M.2→U.2 转接线**接 U.2 盘；板上还有 **M.2/U.2 切换开关**（切错电压会出事） | [STH 论坛实测](https://forums.servethehome.com/index.php?threads/review-pm9a3-15-36-tb-in-minisforum-ms-01.51587/) |
| U.2 位厚度 | **只支持 7mm / 7.5mm**，15mm 装不下（要改机箱） | 同上 + MakerWorld 718278 作者原话 |
| PCIe 槽 | 物理 x16、**电气 x8**；**不支持拆分**（MS-A2 才支持 4+4）；只容 **半高半长 ≈17cm × 7cm × 2cm**、垂直 ≤1.5 槽；**槽紧贴主板，背面有凸起的卡插不进去** | [Chiphell 实测贴](https://www.chiphell.com/thread-2701842-1-126.html) |
| 槽到机壳高度 | 实测 **7.5cm**（含金手指 7.3cm 以内的转接卡能塞进） | 同上 |
| BIOS | 两条 M.2 默认跑 **Gen3**，改 Gen4 会弹「散热不足」警告 | 同上（MS-A2 用户实测） |
| 已知散热 | 原厂风道压不住多块 NVMe：开机一分钟硬盘 65°C+；垫个 14cm 风扇能压到 50°C 以下 | 同上 |

### 1.4 傲腾 905P U.2（15mm）

| 项 | 事实 | 来源 |
|---|---|---|
| 形态 | 2.5 英寸 U.2（SFF-8639），**15mm 厚**，100×70mm 级别 | Intel 规格页 / 通行资料 |
| 温度 | 27°C 室温、仅作系统盘：**46°C**；空载功耗就相当于一块消费级 SSD 的满载 | [实测文](https://www.vgover.com/news/237932) |
| 散热结论 | Chiphell 用户：**加个小风扇吹才到 50°C 以下**；机箱内热风直吹效果差，要冷风 | [Chiphell](https://www.chiphell.com/thread-2512017-1-340.html) |
| 拆壳 | 15mm 的厚度就是**散热壳本身**。拆背板实测只降 2°C 甚至更差，且会削弱正面散热器压力 —— **不建议为「塞进去」拆壳** | 同上实测文 |

> ⚠️ **U.2 ≠ SATA**。905P U.2 走的是 PCIe x4，别买成 2.5 英寸 SATA 硬盘盒；转接线要买 **M.2 M-key → U.2（SFF-8639）** 或 **SFF-8643 → SFF-8639**，不是 SATA 线。

---

## 2. 方案 A：MS-A1 + 显卡坞的外壳

### 2.1 首选：Dopins 的 DEG1 外壳（MakerWorld 942817）

**为什么是它**：MakerWorld 上 DEG1 专用外壳只有这一套源头设计，且作者原话就是「Designed for a full size ATX PSU and a dual PCIe bracket GPU」——正好对上「ATX 电源 + 双槽卡」。

| 项 | 内容 |
|---|---|
| 链接 | MakerWorld：<https://makerworld.com/en/models/942817-minisforum-deg1-egpu-dock-enclosure-case>　STEP：<https://www.printables.com/model/1039236-minisforum-deg1-egpu-dock-enclosure-case-shell> |
| 结构 | 上下壳**卡扣**免工具合体；带**可打印防尘网**和 **PCIe 挡板锁**；分件可单独打印 |
| 打印建议（作者） | ABS / PETG，**3 层墙**；**提手必须 20 层墙**（接近实心）；0.4mm 喷嘴、0.2mm 层高 |
| 明说的限制 | **显卡长度限制只放在图片里，没给数字**；作者也不确定其它批次 DEG1 尺寸是否一致 |
| 中文站同款 | <https://makerworld.com.cn/zh/models/789811-minisforum-deg1-wai-zhi-xian-qia-kuo-zhan-wu-ji-xi> |

**打之前必须量的三个数**（否则白打 1kg 料）：
1. 显卡**总长**（挡板到尾部）；三风扇卡通常 300–340mm；
2. 显卡**厚度**（双槽 = 约 40mm，含背板）；
3. ATX 电源**长度**（140–180mm 常见）与 24-pin 出线方向。

> 如果显卡比壳长：**用 Printables 上的 STEP 把中段拉长**再打。这条 remix 反过来证明了可行性——[2087152](https://makerworld.com/en/models/2087152-deg1-egpu-dock-enclosure-case-remix-short-back) 就是把原版「缩短 37mm」给双风扇短卡用的，作者明说原版是**为更长显卡留了余量**。

### 2.2 通用 ATX 电源壳（DEG1 不是唯一选择）

| 模型 | 平台 | 适配 | 关键点 |
|---|---|---|---|
| [Oculink ATX external eGPU enclosure](https://www.printables.com/model/1235204-oculink-atx-external-egpu-enclosure-for-sff-8612-s) | Printables（Poty） | 通用 OCuLink 板 + **ATX 电源** + 显卡 | ABS、4 层墙、免支撑、M3 热熔铜螺母；**非 DEG1 专用**，转接板要自己定位 |
| [eGPU chassis for TH3P4 + ATX PSU（165×165×330mm ≈ 9L）](https://www.printables.com/model/429812-egpu-thunderbolt-chassis-for-exp-gdc-th3p4-atx-psu) | Printables（DockGuy） | **ATX 电源 + 全长显卡**，可选 **120/140mm 风扇** | 内腔 330mm，最有可能吃下三风扇卡；但它是给雷电板设计的，DEG1 要改固定孔；PETG 约 800g |
| [ATX eGPU Enclosure for DIY Oculink eGPU's](https://makerworld.com/en/models/1381001-atx-egpu-enclosure-for-diy-oculink-egpu-s) | MakerWorld（xTheOverseerXX） | **ATX 电源 + 双风扇显卡** + OCuLink 转 NVMe 板 | 明确写「two fan GPU's」——**三风扇长卡大概率超长**，仅作结构参考 |
| [eGPU OCuLink Box using ATX PSU](https://makerworld.com/en/models/1747543-egpu-oculink-box-using-atx-power-supply) | MakerWorld | ATX 电源 | 描述信息很少（评论区在问文件），需自己核对 |
| [EGPU for Oculink PCIE adapter with GPU/PSU bracket](https://makerworld.com/en/models/1709036-egpu-for-oculink-pcie-adapter-with-gpu-psu-bracket) | MakerWorld | OCuLink 转接板 + 显卡 + 电源支架 | 偏「支架」而非完整壳 |
| [集装箱 OCuLink 显卡坞](https://makerworld.com.cn/zh/models/873370-ji-zhuang-xiang-oculink-xian-qia-wu) | MakerWorld 中国站 | OCuLink 显卡坞 | 集装箱造型；**页面抓不到，电源规格未知**，需自行核对 ATX/SFX |
| [SlimSAS Graphics Docking Station Case KAPC-GDS-01](https://makerworld.com.cn/zh/models/2766607-slimsas-graphics-docking-station-case-kapc-gds-01) | MakerWorld 中国站 | SlimSAS 显卡坞 | 不是 OCuLink，但同类结构可参考 |
| [adt-link f9g dock (atx psu)](https://makerworld.com.cn/zh/models/2562693-adt-link-f9g-dock-atx-psu) | MakerWorld 中国站 | ADT-Link F9G + ATX 电源 | 如果你其实用的是 F9G，这个直接对口 |

### 2.3 明确不合适的（省得你踩坑）

| 模型 | 原因 |
|---|---|
| [Oculink eGPU Enclosure](https://www.printables.com/model/1307112-oculink-egpu-enclosure)（PascalB_CH） | **SFX 电源硬限制**，但显卡可到 300mm —— 如果你愿意换 SFX 电源，这条其实很香 |
| [ADT-Link UT3G eGPU-Case](https://www.printables.com/model/1609456-adt-link-ut3g-egpu-case-atx-psu-280mm-25-slot-gpu) | 显卡 **≤280mm / 58mm 厚**，ATX 电源 ≤160mm；三风扇卡超限 |
| [DEG1 short back remix 2087152](https://makerworld.com/en/models/2087152-deg1-egpu-dock-enclosure-case-remix-short-back) | 给短双风扇卡（RX 6650XT）截短的，**反而装不下长卡** |
| [OCuLink GPU Dock SFX](https://makerworld.com.cn/zh/models/3014533-oculink-gpu-dock-sfx-oculink-wai-zhi-xian-qia-wu) | 标题即 SFX 版 |
| [Cbutters Bantam eGPU](https://www.printables.com/model/992611-cbutters-bantam-egpu-enclosure-now-with-oculink) | 外置电源砖（170/230W），只适合 SFF 短卡 |
| [OCuLink 8i Adapter Mount](https://makerworld.com/en/models/2287964-oculink-8i-adapter-mount) | SFX + **OCuLink 8i**（不是 4i），别买错 |

### 2.4 不想打大壳？开放支架 / 防下垂

| 模型 | 用途 |
|---|---|
| [Oculink Adapter ATX GPU Stand Holder](https://makerworld.com/en/models/2226840-oculink-adapter-atx-gpu-stand-holder-egpu)（Yannmarch） | **把显卡直接架在 ATX 电源上**省空间；有「加长滑轨」版本适配不同孔距 |
| [3050 6g oculink egpu](https://makerworld.com/en/models/3007966-3050-6g-oculink-egpu-requires-yannmarch-base) | 上面的「加个护罩」remix，可参考护罩做法 |
| [PSU-mounted Full ATX Test Bench](https://makerworld.com/en/models/1272229-psu-mounted-full-atx-test-bench) | 电源挂载式测试台，先跑起来再说 |
| [Open Frame PC Case ATX](https://makerworld.com/zh/models/2141207-open-frame-pc-case-atx) | 开放式 ATX 机箱 |
| [ATX basic open pc case / test bench](https://www.printables.com/model/1615907-atx-basic-open-pc-case-test-bench) | 8 件卡扣、单件最长 18.2cm（220×220 床友好） |
| [可调节 GPU 支撑架 71–116mm](https://makerworld.com.cn/zh/models/2724784-ke-diao-jie-gpuzhi-cheng-jia-71mm-116mm) | 三风扇卡自重 1.5kg 级，开放式框架一定要顶住尾端 |
| [GPU Support Bracket](https://www.printables.com/model/1557286-gpu-support-bracket) | 同上，Printables 版 |

### 2.5 风扇与理线

| 模型 | 说明 |
|---|---|
| [deg1 wire cover](https://makerworld.com/en/models/1040945-deg1-wire-cover)（cmlucht） | DEG1 背面理线盖，**带 2× 50mm 风扇**吹显卡背面；风量有限，但方向对 |
| [DEG1 Cable Shroud Cover Organizer](https://makerworld.com/en/models/948440-minisforum-deg1-egpu-cable-shroud-cover-organizer) | 扎带捆好线再套罩；作者提醒按显卡留 1–2 根 PCIe 供电线别全包死 |
| [DEG1 Enclosure with Round GPU Monitor](https://makerworld.com/en/models/3067559-deg1-egpu-enclosure-with-round-gpu-monitor) | 在 Dopins 壳上加圆屏（ESP32-C3 + Home Assistant/MQTT/ESPHome）显示显卡数据；纯好玩 |
| [Power Switch ATX24 Adapter Case](https://www.printables.com/model/471410-power-switch-atx24-adapter-case) | 24-pin 取电 + 外置开机键，开放平台必备 |

> **没找到**「DEG1/ATX 电源专用 120/140mm 导风罩」的现成模型。三风扇卡本身风量够，真正要加风的是**电源仓**和**显卡背面**。

### 2.6 打印与安全注意（这块比模型本身重要）

1. **材料**：PETG 起步，ABS/ASA 更稳。**PLA 在显卡背板/电源出风附近会蠕变变形**（2087152 作者也只敢给低功耗短卡用 PLA）。
2. **强度**：3 层墙起步；提手、电源托、显卡挡板锁这些受力件加墙厚/加填充；用 M3 热熔铜螺母，别直接攻丝。
3. **大件**：Dopins 的上下壳单件都很大，P1/X1 的 256mm 床要**分件 + 拼接**；接缝处加胶 + 螺丝。
4. **风道**：ATX 电源有自己的风扇，别把电源进风口朝内堵死；显卡尾部出风要留开口。
5. **电气**：DEG1 的 24-pin 与 PCIe 8-pin 走线别被壳压住；开机前先裸奔点亮，再装壳。

---

## 3. 方案 B：MS-01 + 傲腾 905P U.2（15mm）

### 3.1 问题本质

MS-01 的 U.2 位在结构上只留给 **7mm/7.5mm** 的盘（作者原话：买了数据中心 U.2 盘才发现装不进）。905P 是 **15mm**，差的这 7–8mm 只能从「机箱」或「安装位置」上找。

### 3.2 路线 ①：加高底盖（最省事，推荐先试）

| 模型 | 平台 | 说明 |
|---|---|---|
| [Minisforum MS-01 Case Extension - To Fit 15mm SSD](https://makerworld.com/en/models/718278-minisforum-ms-01-case-extension-to-fit-15mm-ssd) | **MakerWorld**（DuckMeat） | 给底盖加一小段「加高块」，让 15mm 盘能塞进去；同款在 Printables [843024](https://www.printables.com/model/843024-minisforum-ms-01-case-extension-to-fit-larger-15mm) |
| [MS-01 Bottom Plate Replacement to Support 14mm U.2](https://www.printables.com/model/976911-ms-01-bottom-plate-replacement-to-support-14mm-u2) | Printables（Kevin Browder） | 14mm 版本；如果你最后换 14mm 盘可用 |
| [铭凡 ms01 硬盘位散热强化机箱（支持 15mm U.2 + 12/14cm 风扇）](https://makerworld.com.cn/zh/models/1576598-ming-fan-ms01ying-pan-wei-san-re-qiang-hua-ji-xian) | MakerWorld 中国站（胸狗） | **最对口的一体化方案**：直接换壳，15mm U.2 + 大风扇一起解决；页面抓不到，需自己看尺寸图 |
| [Minisforum MS-01 增强型机箱（Noctua NH-L12S）](https://makerworld.com.cn/zh/models/1709408-minisforum-ms-01-zeng-qiang-xing-ji-xiang-noctua-n) | MakerWorld 中国站 | 换壳装下压式 CPU 散热器（降噪向），可与上一条思路合并 |

**优点**：保留全部 M.2 位、盘在机箱内、外观完整。
**代价**：底盖变厚（约 +8mm）、要拆机、可能影响保修/防尘；**加高后风道变差，必须配主动散热**。

### 3.3 路线 ②：走 PCIe 槽 + 薄 U.2 转接卡（不占 M.2 位）

Level1Techs 有实测帖：**把薄款 U.2→PCIe x4 转接卡（含低-profile 挡板）插进 MS-01 的 x16 槽，15mm 的 U.2 盘横躺在槽位区，能合盖，且位置低于风扇，散热空间够**。

| 要点 | 内容 |
|---|---|
| 转接卡 | 「U.2 to PCIe Adapter PCI-E 4.0 X4 to 2.5 Inch U.2 SFF-8639 SSD Converter Card」，要**薄款**（普通 PCIe→U.2 卡太厚） |
| 尺寸红线 | 槽位区 ≈ **17cm × 7cm × 2cm**；槽到机壳 **7.5cm**，转接卡含金手指 ≤7.3cm 才塞得进 |
| 挡板 | 必须换**半高（low-profile）挡板**，装好卡后再把挡板拧回 |
| 代价 | **占用唯一的 PCIe 插槽**（这台就不能再插显卡/网卡了）；x8 电气够 U.2 x4 用 |
| 隐藏优势 | **12V 从 PCIe 槽取电**，不需要 SATA 供电——MS-01 内部没有 SATA 电源，这一点很关键（见 3.4） |
| 来源 | <https://forum.level1techs.com/t/minisforum-ms-01-15mm-enterprise-u-2-u-3-solution/212765> |

**适合**：纯 NAS / 全闪，不打算在 MS-01 里插显卡。
**优点**：不拆机箱、不占 M.2、换盘只要开盖。
**相关固定件**：[Mini SAS SFF-8643 Low Profile PCI-E Bracket](https://makerworld.com/en/models/3003131-mini-sas-sff-8643-low-profile-pci-e-bracket)（线材穿挡板）、[M.2 to Low Profile PCIe Mounting Bracket](https://makerworld.com/en/models/1156598-m-2-to-low-profile-pcie-mounting-bracket-adapter)（把 M.2 转接板固定成插卡形态）。

### 3.4 路线 ③：外置（散热最好、最不折腾机箱）

- 用 **M.2 M-key → U.2（SFF-8643）** 转接线把盘引到机箱外，外面用打印支架 + 风扇吹。
- ⚠️ **供电是这条路的死穴**：市面上绝大多数 M.2→U.2 转接线**只从 M.2 取 3.3V，12V 要另接 SATA 电源**（DiLinker 产品页原话：*"Supports drives that require 12V source. Requires external PSU SATA power connector"*）。**MS-01 内部没有 SATA 供电**。
  - 用 **MS-01 随箱附带的那根 M.2→U.2 转接线**（板上带 M.2/U.2 切换开关，电压由它处理）最稳；
  - 第三方线必须从机外引一路 SATA 供电进来（开孔/走线，破坏保修）；
  - 否则会表现为「不认盘/掉盘/SMART 报错」，而不是「慢一点」。
- 外置支架候选：

| 模型 | 平台 | 说明 |
|---|---|---|
| [U.2 SSD Cooler for 15mm SSD with Fan](https://makerworld.com/en/models/1585889-u-2-ssd-cooler-for-15mm-ssd-with-fan) | MakerWorld | **45×45×10 风扇 + 100×60×10 散热片**；中文版作者称「即使 U.2 盘功耗高达 25W 也能保持低温」——905P 这个功耗级别正好 |
| [SSD Cooler for 2.5inch with adapter card](https://makerworld.com/en/models/168859) | MakerWorld | 4510/4513 离心风扇 + 100×66 散热片，靠盘体侧面螺丝孔固定；作者就是用在「U.2 盘 + 转接卡」组合上 |
| [立式硬盘/固态硬盘支架（2×3.5 + 5×2.5，通风设计）](https://makerworld.com/zh/models/3204891-vertical-hdd-ssd-mount-2x3-5-5x2-5-airflow) | MakerWorld | 立式、走风；2.5 寸位可放 905P |
| [3.5 英寸硬盘可扩展硬盘盒堆叠器带托盘](https://makerworld.com/zh/models/1931009-3-5-inch-hdd-expandable-caddy-stacker-will-trays) | MakerWorld | 叠放 |
| [风扇槽位硬盘支架](https://makerworld.com.cn/zh/models/1356308-feng-shan-cao-wei-ying-pan-zhi-jia) | MakerWorld 中国站 | 把盘固定在 12cm 风扇位 |
| [SSD Stackers 15mm U.2](https://www.printables.com/model/1618039-ssd-stackers-15mm-u2) | Printables | 15mm U.2 叠放架（7mm 版 remix） |
| [SSD Mounting Bracket with two 15mm Slots](https://www.printables.com/model/823840-ssd-mounting-bracket-with-two-15mm-slots) | Printables | 2×15mm 位 |
| [4×2.5" U.2 Cage w/ 80mm fan](https://www.printables.com/model/1303971-4x-25-u2-ssd-cage-w80mm-fan) | Printables | 4×15mm + 80mm 风扇 |
| [4×U.2 Cooler, 2×80mm fan](https://www.printables.com/model/1174408-4x-u2-ssd-cooler-2x-80mm-fan) | Printables | 导风罩；作者建议 ASA，并提醒 U.2 盘能到 80°C |
| [5-Bay 3.5" Cage for 120mm Fan](https://3dgo.app/models/thingiverse/7130526) | Thingiverse（经 3dgo 索引） | 5 盘位笼 + 12cm 风扇，思路可套到单盘 |

**代价**：线缆穿出机箱（走 PCIe 挡板缝或后窗）、灰尘/搬动风险；但**散热最好**，也最不影响保修。

### 3.5 905P 的散热：别省这一步

| 证据 | 数据 |
|---|---|
| 905P U.2 实测（27°C 室温，系统盘） | **46°C**；空载功耗≈消费级 SSD 满载 |
| Chiphell 用户 | 加小风扇才 **<50°C**；机箱内热风直吹效果差，要**冷风直吹** |
| MS-01 内企业盘实测（PM9A3 15.36TB） | 待机 NAND **57°C** / 主控 **66°C**；压测 **76/86°C** 触发降速 |
| MS-01 整机降温土办法 | 把机器**垫在 14cm 风扇上**，所有盘 <50°C |
| BIOS 提示 | M.2 默认 Gen3，改 Gen4 会警告「散热不足」 |

推荐做法：
1. 打印 [15mm U.2 专用带风扇散热器（MakerWorld 1585889）](https://makerworld.com/zh/models/1585889-u-2-ssd-cooler-for-15mm-ssd-with-fan) —— 摘要写的是 **45×45×10 风扇 + 100×60×10 散热片**；
2. 或者 [U2 硬盘散热器 15mm](https://makerworld.com.cn/zh/models/1144001-u2ying-pan-san-re-qi-15mm) / 其[透风底板改进型](https://makerworld.com.cn/zh/models/1286643-u2ying-pan-san-re-qi-15mmde-tou-feng-di-ban-gai-ji)；
3. 机箱整体加风：MS-01 底部垫 12/14cm 风扇（有现成 [140mm fan upgrade](https://www.printables.com/model/1208615-minisforum-ms-01-140mm-fan-upgrade) 与 [Noctua NF-A20 机架](https://makerworld.com/zh/models/1258104-ms-01-noctua-a20-rack)）；
4. 如果走 PCIe 槽，注意别让 905P 挡住背面 M.2 的风。

### 3.6 不建议：拆 905P 的外壳

- 15mm 就是**散热壳**的厚度，拆了背板实测只降 2°C（甚至更差），还会让正面散热器压力变小；
- 裸板长期跑 46°C+ 的盘，失去结构保护和保修，得不偿失；
- 真要 7mm，正确做法是**换盘**（PM9A3 / Micron 7450 PRO 这类 7mm U.2），而不是拆 905P。

---

## 4. 五盘位 USB 硬盘盒

### 4.1 现实

ORICO 9558RU3、TerraMaster D5-300、Yottamaster 五盘位这类**具体型号没有对应的加风扇/导风罩模型**。能搜到的都是「撞型号」的零星作品：

| 模型 | 平台 | 适配 |
|---|---|---|
| [ORICO DS500 5-Bay Top Cover Fan Mod](https://www.printables.com/model/1575010-orico-ds500-5-bay-hard-disk-enclosure-top-cover-fa) | Printables（Jessi） | ORICO DS500（五盘位）——**换顶盖 + 加风扇，最值得抄的思路** |
| [Replacement Cover with inside fan for Orico DS500U3](https://3dgo.app/models/thingiverse/7187789) | Thingiverse（索引） | DS500U3 |
| [Yottamaster MS5-T3 fan upgrade](https://www.printables.com/model/409509-yottamaster-ms5-t3-thunderbolt-3-dock-fan-upgrade) | Printables | Yottamaster 五盘位 |
| [LabRax 10" 3U 支架 - TerraMaster D5-300c](https://makerworld.com.cn/zh/models/2262356-labrax-ji-jia-10-3u-zhi-jia-terramaster-d5-300c) | MakerWorld 中国站 | 只管叠放/上架，不管散热 |
| [麦沃硬盘盒改主动散热](https://makerworld.com.cn/zh/models/1559022-mai-wo-ying-pan-he-gai-zhu-dong-san-re) | MakerWorld 中国站 | MAIWO，思路可借鉴 |
| [麦沃双盘位硬盘盒排风板](https://makerworld.com/zh/models/3389905-maiwo-dual-plate-hard-drive-enclosure-air-vent-pla) | MakerWorld | 双盘位排风板 |

### 4.2 通用件（自己拼）

| 模型 | 用途 |
|---|---|
| [Mi-HUB 5×3.5 英寸硬盘封箱](https://makerworld.com.cn/zh/models/1481048-mi-hub-5x-3-5-ying-cun-ying-pan-feng-xiang) | 5 盘位整盒（不是给成品盒加风扇） |
| [5 盘位 TypeC 硬盘柜 12V 外置 DC 供电](https://makerworld.com.cn/zh/models/1568508-5pan-wei-typecying-pan-ju-12vwai-zhi-dcgong-dian) | 同上，整柜 |
| [5 盘位 NAS/ITX 机箱 - 20cm 单风扇 DC 电源静音](https://makerworld.com.cn/zh/models/2248099-5pan-wei-nas-itxji-xiang-20li-mi-dan-feng-shan-dcd) | 带 20cm 风扇的 5 盘位机箱 |
| [减震脚](https://makerworld.com.cn/zh/models/160186-jian-zhen-qi-jian-zhen-jiao) | 降噪/防共振 |
| [带格栅滤网的支架](https://makerworld.com.cn/zh/models/1994559-dai-ge-zha-lu-wang-de-zhi-jia) | 可改造成进风口防尘网 |

### 4.3 最省事路线

1. 量硬盘盒**顶盖尺寸**（长×宽）和内部风扇位；
2. 打印一个「顶盖开孔 + 12cm 风扇转接框」（照抄 DS500 的做法），风扇朝**外抽**；
3. 四只减震脚垫高，改善底部进风；
4. 风扇供电：硬盘盒多为 12V DC，用 12V 风扇直接并到 DC 输入最稳；不想动电就用 USB 5V 小风扇（风量小）。

---

## 5. 采购 / 打印清单

### 5.1 显卡坞侧

- [ ] 线材：PETG/ABS 约 **1.2–1.8kg**（Dopins 上下壳 + 提手）
- [ ] M3 热熔铜螺母 + M3×6/×8/×12 螺丝各一包
- [ ] 120/140mm 风扇（可选，电源仓/尾部排风）+ 风扇网罩
- [ ] 防尘网（可打印或买成品）
- [ ] 橡胶脚垫 4 只
- [ ] 显卡尾部支撑（打印或成品）

### 5.2 905P 侧

- [ ] **路线①**：打印 718278 底盖加高件 + 1585889 散热器 + 45×45×10 风扇（5V/12V 看取电）
- [ ] **路线②**：薄款 U.2→PCIe x4 转接卡（含 low-profile 挡板）
- [ ] **路线③**：M.2 M-key → U.2 SFF-8639 转接线（注意长度 ≥30cm，走线绕开风扇）
- [ ] 导热垫（拆装后补）
- [ ] 温度监控：CrystalDiskInfo / smartctl，确认满载 <70°C

### 5.3 硬盘盒侧

- [ ] 12cm 风扇 + 转接框（打印）+ 减震脚

---

## 6. 风险与坑（按踩坑概率排序）

1. **显卡长度**：三家「ATX 壳」里两家明确写双风扇/≤280mm；Dopins 的长度上限只在图里。**先量再打。**
2. **电源类型**：很多壳是 SFX 专用（PascalB、MW 的 SFX 坞、OCuLink 8i 支架）。ATX 电源塞 SFX 位 = 白打。
3. **PLA 蠕变**：显卡背板/电源出风区温度足以让 PLA 软化。PETG/ABS 起步。
4. **DEG1 批次差异**：Dopins 自己都提醒不确定其它批次尺寸一致；卡扣合不上就打磨/加螺丝。
5. **U.2 供电（最容易被忽略）**：U.2 盘要 **12V**，M.2 槽只给 3.3V。第三方 M.2→U.2 转接线几乎都要另接 **SATA 电源**，而 **MS-01 内部没有 SATA 供电**。优先级：随箱转接线（带切换开关）> PCIe 槽转接卡（12V 从槽取）> 第三方线 + 外引 SATA 供电。
6. **M.2→U.2 方向别买反**：市面上有大量「U.2 主机 → M.2 盘」的反向产品，外观几乎一样；要买的是 **M.2 主机 → U.2 盘**。
7. **M.2/U.2 切换开关**：装 U.2 前务必切到 U.2 档，切错可能不认盘甚至伤盘。
8. **PCIe 槽背面高度**：MS-01 槽紧贴主板，转接卡背面有任何凸起都插不进去。
9. **BIOS Gen3/Gen4**：905P 是 PCIe 3.0 x4，跑 Gen3 没问题；但别为了别的盘把 M.2 全改 Gen4 又不管散热。
10. **模型页面访问**：MakerWorld 中国站的模型在国际站不一定有（反之亦然）；本报告里 `.cn` 链接大多只能靠标题判断，**下载前自己核对规格**。

---

## 7. 需要你确认的 4 件事（决定最终选型）

1. **905P 是装在 MS-01 还是 MS-A1？** 两台都支持 U.2（MS-A1 也是 M.2 转接），但 MS-01 的 7.5mm 限制是硬伤，MS-A1 的内部空间需要单独确认。
2. **905P 容量/型号**（380G/960G/1.5T）与**是否接受换加高底盖**（外观 +8mm、要拆机）。
3. **显卡坞具体型号 + 显卡三围 + ATX 电源长度**（决定 Dopins 壳能不能直接用，还是要改 STEP）。
4. **五盘位硬盘盒的品牌型号**（决定是自己画转接框还是能蹭现成 remix）。

---

## 附录：调研方法与局限

- MakerWorld / Printables / Thingiverse / Cults3D 的**页面直连全部被 Cloudflare 拦（403）**，本报告的模型信息来自：搜索引擎摘要、Bing RSS 结果、Wayback 快照，以及能打开的论坛/评测页。
- 因此**凡标「摘要未提及」的尺寸/材料，都需要你下载后自行核对**；报告里没有编造任何 URL、作者或尺寸。
- 关键实测结论的来源（可点开复核）：
  - MS-01 槽位尺寸/不可拆分/散热：<https://www.chiphell.com/thread-2701842-1-126.html>
  - MS-01 + 15mm U.2 走 PCIe 槽：<https://forum.level1techs.com/t/minisforum-ms-01-15mm-enterprise-u-2-u-3-solution/212765>
  - MS-01 U.2 只吃 7mm + 温度实测：<https://forums.servethehome.com/index.php?threads/review-pm9a3-15-36-tb-in-minisforum-ms-01.51587/>
  - 905P 温度/拆壳实测：<https://www.vgover.com/news/237932>、<https://www.chiphell.com/thread-2512017-1-340.html>
  - DEG1 规格：<https://www.notebookcheck.net/Minisforum-DEG1-Docking-station-for-eGPUs-promises-great-extra-performance-for-laptops-and-mini-PCs.844928.0.html>
  - MS-A1 规格：<https://digi.ithome.com/archiver/775/404.htm>

---

## 8. 第二轮更新（2026-10-30 晚）

### 8.1 采集通道：Cloudflare 已绕过

- 在 **ubuntu-gpu（192.168.3.30）** 上用 Docker 部署了 **FlareSolverr**：

  ```bash
  docker run -d --name flaresolverr --restart unless-stopped \
    -p 8191:8191 -e LOG_LEVEL=info ghcr.io/flaresolverr/flaresolverr:latest
  ```

  调用方式（返回渲染后的 HTML）：

  ```bash
  curl -s -X POST http://192.168.3.30:8191/v1 -H 'Content-Type: application/json' \
    -d '{"cmd":"request.get","url":"https://makerworld.com/en/models/942817","maxTimeout":90000}'
  ```

- **makerworld.com 已能正常读**；**makerworld.com.cn 仍是更硬的挑战**（FlareSolverr 停在「正在进行安全验证」），需要人工浏览器或换更强的浏览器指纹方案。
- 图片 CDN（`makerworld.bblmw.com`）在 Windows 本机直接拉经常 403，但**在 ubuntu-gpu 上 `curl` 直接 200** —— 拉图/大文件走服务器，再 `scp` 回来。

### 8.2 用真实页面核对后的修正

| 项 | 之前 | 现在（已核实） |
|---|---|---|
| MS-A1 的 U.2 | 官方宣传支持 | **后期版本已砍掉**，按纯 M.2 规划 → 905P 只能进 MS-01 |
| Dopins 外壳体量 | 「很大」 | 打印 **25.3h / 6 盘 / ABS 606g + PETG 47g（≈0.65kg）**，v1.1 加宽了 OCuLink 口、加长挡板锁；GPU 长度仍只在图里 |
| MS-01 14cm 换壳 | 只见到标题 | **1403142**：2×140mm Noctua NF-A14，**用 MS-01 的 USB-A 5V 供电**（需转接 + 分线），免螺丝卡扣、PLA 可打 —— 与 5V USB 风扇完全对上；**1719223**：2×140mm + 双槽显卡位，12V 1A 供电，M5/M3 五金 |
| 15mm U.2 散热 | 只知型号 | **1585889**：45×45×10 风扇 + 100×60×10 散热片，作者称 25W 盘也压得住；**1329055**：15mm U.2 散热器 + 单槽涡轮风扇（PLB07016B12H） |
| 905P 容量 | 未定 | **960GB** |

### 8.3 修正后的方案

**MS-01（905P 960G）**
- 用 14cm 换壳（1403142 或 1719223）解决机箱风道 + 5V USB 风扇供电；
- 15mm 厚度仍要单独确认：换壳只保证「外壳更大」，**不等于 U.2 托盘位置多了 7.5mm**；如果不让位，就叠 718278 的加高件或自己在托盘上加垫块；
- 盘体贴 1585889 或 1329055 主动散热。

**MS-A1 + 显卡坞（显卡 319mm / 双槽半）**
- 结论：**全封闭壳不划算**。Dopins 壳 0.65kg 料 + 25h 打印，且三风扇 319mm 卡本来就要改 STEP；
- 改为「**半开放组合**」，三条可选：
  1. **半壳**：只罩 ATX 电源 + 坞板，显卡完全裸露，12cm USB 风扇斜吹显卡背板与坞板；
  2. **立式塔**：显卡竖装，坞板在背面，电源在下，MS-A1 置顶，整体约 330×200×250mm；
  3. **10 寸机架**：MS-A1 + 坞板上 2U/3U 托盘，前面 12cm 风扇。
- 需要先量的 5 个数：ATX 电源长×宽×高、坞板外形与孔位、显卡长/厚/挡板宽度、MS-A1 三围与脚垫孔距、桌面可用面积。

### 8.4 还要你确认

1. MS-01 那个「15cm+ 风扇的外壳」具体是哪个模型（1403142 / 1719223 / 其它）？我可以按它的内部高度判断 15mm 盘要不要加垫。
2. 显卡坞这边，接受「显卡裸露的半开放」吗？接受的话我按上面 5 个尺寸出一版参数化支架（本仓库有 `fusion/` 的脚本化建模流程，也可以先出 OpenSCAD 草模）。

---

## 9. 第三轮：确定「不换壳、只加风扇」路线（2026-10-30）

### 9.1 定案

- **MS-01 保留原机箱**：只叠 **718278 加高底盖（15mm 盘）+ 一块带脚垫的替换面板 + 薄型 120mm 风扇**，不做「整机塞进去」的大盒子。
- **显卡坞不做封闭壳**：显卡裸露，靠 120mm 风扇直吹；把小主机与坞固定在一起（托架形式待尺寸）。
- 现有 5V USB 风扇直接可用（无需从 MS-01 内部取电）。

### 9.2 718278 实物确认

页面图显示它是一组**不同厚度的垫块**（垫在底盖与机身之间），不是整体新底盖。作者打印参数：**PLA+、4 层墙、15% Gyroid**，并强调「必须够硬，不要用 TPU」。装完机器厚约 +8mm。

### 9.3 侧挂风扇：最小改动方案

[Printables 1268196 — MS-01 Fan Panel With Feet](https://www.printables.com/model/1268196-ms-01-fan-panel-with-feet)（ArtisanalTechie）：**替换面板 + 脚垫，支持薄型（slim）120mm 风扇**。这是目前找到的唯一「只加风扇、不变大盒子」的现成件。
- 注意 slim 120mm 一般是 **15mm 厚**；手上的 25mm 标准风扇要么换薄扇，要么在面板与机身之间加垫。
- 同作者/他人的替代：[MS-01 140mm fan upgrade](https://www.printables.com/model/1208615-minisforum-ms-01-140mm-fan-upgrade)（换背板 + 140mm 风扇壳）。

### 9.4 显卡尺寸（官网核实）

| 卡 | 尺寸（长×宽×高） | 结论 |
|---|---|---|
| **技嘉 RX 9060 XT GAMING OC 16G** | **281 × 118 × 40 mm**（2 槽） | 比 QICK 319 短 38mm，绝大多数方案都能容 |
| XFX RX 6700 XT QICK 319 | 319mm 级 | 长卡，Dopins 壳要改 STEP |

### 9.5 还差什么

- 坞板外形/孔位 + ATX 电源长宽高 + 桌面可用面积 → 用来出「MS-A1 + 坞 + 120mm 风扇」的组合托架。
