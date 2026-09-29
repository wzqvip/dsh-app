/**
 * 客户端探针：验证第三方客户端插件能否注册到 remote waterfall。
 *
 * 为什么单独做这一步：
 *   架构发现表明 answerer 在【客户端】（见 research/11）。但"第三方客户端插件
 *   能不能用 ctx.remote.$on"与"用了会不会把官方 answerer 挤掉"是两个独立问题。
 *   先只回答第一个：注册 + 计数 + 显示，**不认领、不返回答案、不干扰官方链路**。
 *
 * 安全性：handler 里第一件事就是 return next()，把决定权完全交回官方。
 *          它只在旁边记一笔数，没有任何副作用。
 *
 * 可见性：本插件是浏览器侧脚本，我（AI）看不到它的 console。
 *         所以把计数画成一个极小角标，让用户能直接看到。
 */

const STYLE_ID = 'dsh-efficiency-probe-style';

/** 极小的诊断角标（不遮挡、可点击隐藏） */
function makeProbeBadge({ h, useState, useEffect }) {
  return function ProbeBadge() {
    const [state, setState] = useState(() => globalThis.__DSH_EFFICIENCY_PROBE__ ?? { seen: 0, last: null, hasRemote: null });

    useEffect(() => {
      const read = () => {
        const s = globalThis.__DSH_EFFICIENCY_PROBE__;
        if (s) setState({ ...s });
      };
      const timer = setInterval(read, 1000);
      read();
      return () => clearInterval(timer);
    }, []);

    // 没收到任何事件时不显示，避免日常干扰
    if (!state || state.seen === 0) return null;

    return h(
      'div',
      {
        style: {
          position: 'fixed',
          left: 8,
          bottom: 8,
          zIndex: 9001,
          background: 'rgba(20,20,24,.86)',
          color: '#eee',
          border: '1px solid #4a90d9',
          borderRadius: 8,
          padding: '4px 8px',
          font: '11px/1.5 ui-monospace, monospace',
          pointerEvents: 'auto',
        },
        title: state.last ? JSON.stringify(state.last, null, 2) : '',
      },
      `[efficiency probe] 收到提问 ${state.seen} 次`,
      state.hasRemote === false ? ' ⚠️ 无 ctx.remote' : '',
    );
  };
}

/**
 * 在客户端注册只读探针。返回是否注册成功。
 * @param {object} ctx 客户端 cordis 上下文
 */
export function installProbe(ctx) {
  globalThis.__DSH_EFFICIENCY_PROBE__ = { seen: 0, last: null, hasRemote: null, error: null };

  const remote = ctx?.remote;
  globalThis.__DSH_EFFICIENCY_PROBE__.hasRemote = !!remote;

  if (!remote || typeof remote.$on !== 'function') {
    console.warn('[dsh-efficiency] ctx.remote.$on 不可用，探针未注册');
    return false;
  }

  try {
    ctx.effect(
      () =>
        remote.$on('user-questions/request', function probeListener(request, next) {
          const s = globalThis.__DSH_EFFICIENCY_PROBE__;
          if (s) {
            s.seen += 1;
            s.last = {
              callId: request?.wait?.callId ?? null,
              timed: request?.wait?.timed ?? null,
              count: Array.isArray(request?.questions) ? request.questions.length : null,
              at: new Date().toISOString(),
            };
          }
          console.log('[dsh-efficiency] probe: user-questions/request 命中', request?.wait?.callId);
          // 只读：立刻把决定权交回官方 answerer
          return next();
        }),
      'dsh-efficiency: probe listener',
    );
    console.log('[dsh-efficiency] probe 已注册到 user-questions/request');
    return true;
  } catch (err) {
    globalThis.__DSH_EFFICIENCY_PROBE__.error = String(err);
    console.warn('[dsh-efficiency] 探针注册失败', err);
    return false;
  }
}

export { makeProbeBadge };
