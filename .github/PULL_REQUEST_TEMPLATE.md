## 这个 PR 做了什么

<!-- 一句话说明 -->

## 关联 Issue

<!-- 如 Closes #12 -->

## 类型

- [ ] 功能（feat）
- [ ] 修复（fix）
- [ ] 文档（docs）
- [ ] 重构 / 杂务（refactor / chore）

## 自查清单

- [ ] 没有引入**消耗额外 token** 的默认行为
- [ ] 没有声明 `@deepseek-ai/dsh*` 的 `peerDependencies`（本项目刻意不声明，见 plan.md §6.1）
- [ ] 新增的用户可见文案走 `ctx.locale`
- [ ] 没有注册 `root` 槽位
- [ ] 若改了核心层：**关掉桌宠时功能仍可用**（L1 不依赖 L2）
- [ ] 若涉及局域网：已按 [SECURITY.md](../docs/SECURITY.md) 与 plan.md §5 的安全门槛处理
- [ ] 文档已同步更新（README / ARCHITECTURE / plan / todo 中受影响的部分）

## 素材与许可

- [ ] 本 PR **未提交**任何第三方受版权保护的素材
- [ ] 若提交了素材：我拥有版权或已获授权，且**未复制** `dsh-pet` 的素材文件
- [ ] 若涉及 `dsh-pet` 相关展示：已保留署名 <https://github.com/PC2005-cloud/dsh-pet>

## 测试与验证

<!-- 你怎么验证的？贴出复现步骤或截图 -->
