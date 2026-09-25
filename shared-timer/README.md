# 多标签页共享计时器

纯静态页面，无构建步骤。技术栈：**BroadcastChannel + IndexedDB + performance.now()**。

## 运行

```bash
cd shared-timer
python3 -m http.server 8000
```

浏览器打开 `http://localhost:8000`，再复制 3 个标签页（共 4 个）。

> 必须通过 http(s) 同源访问，`file://` 下 IndexedDB / BroadcastChannel 行为不可靠。

## 功能

- 开始 / 暂停（同一按钮切换）、重置、设置时长（分 + 秒，运行中不可改）
- 倒计时到 0 自动置为「已完成」
- 只做计时和同步：无任务、无历史、无提醒

## 设计：验收标准如何被满足

| 验收标准 | 机制 |
|---|---|
| 4 标签页误差 < 50ms | 状态以「墙钟锚点」共享，各标签页映射到本地 `performance.now()` 推算；BroadcastChannel 投递延迟 <5ms，渲染对齐 rAF |
| 同时开始/暂停不冲突 | 所有操作在单个 IndexedDB readwrite 事务内 read-modify-write（跨标签串行化），操作幂等 + version 单调递增，后到者自动丢弃 |
| 标签页关闭不丢 | 状态持久化在 IndexedDB；计时是锚点推算，不依赖任何标签页存活 |
| 离线恢复后正确 | 全部数据本地化，无网络依赖；恢复后按锚点重算 |
| 时钟漂移可校正 | 心跳携带发送方墙钟，EMA 估计跨标签页时钟偏移；运行中每秒比对 wall/perf 双钟，系统时钟跳变 >250ms 自动重锚定 |
| 后台节流不跳变 | 时间永远由时钟推算而非累加；后台仅降低渲染频率，回前台立即按当前时钟渲染 |
| 刷新后时间一致 | 启动时从 IndexedDB 恢复 + 广播 `sync-request` 获取最新状态 |

## 核心状态模型（IndexedDB 单条记录）

```js
{
  status: 'idle' | 'running' | 'paused' | 'finished',
  durationMs,       // 设定时长
  baseElapsedMs,    // 锚点之前已累计的毫秒
  anchorWallMs,     // 当前运行段起点墙钟（仅 running）
  version,          // 单调递增，并发冲突仲裁
  updatedBy,        // 最后操作的标签页
}
```

任意时刻已计时长 = `baseElapsedMs + (performance.now() - anchorPerfMs)`，
其中 `anchorPerfMs` 是把共享墙钟锚点映射到本地单调时钟的结果。

## 手动验收步骤

1. **一致性**：4 个标签页并排，任一页点开始，肉眼对比 4 个 `MM:SS.CS` 显示，差异应远小于 50ms（调试区可看时钟偏移校正值）。
2. **并发**：两个标签页同时点「开始」或「暂停」→ 只生效一次，版本号只 +1（另一操作幂等丢弃）。
3. **关闭**：运行中关掉 3 个标签页，等 10 秒再开新标签页 → 时间连续累计。
4. **离线**：断网操作计时 → 完全正常；恢复网络后无变化。
5. **时钟漂移**：运行中修改系统时间（`sudo date -s '+1 hour'`）→ 1 秒内自动重锚定，显示不跳。
6. **后台节流**：把某标签页切到后台 30 秒再切回 → 时间与其他标签页一致，无跳变。
7. **刷新**：运行中刷新任意标签页 → 刷新后与其余标签页一致。

## 自动化模拟测试

```bash
node test/simulate.mjs
```

用 Node `vm` 模拟 4 个标签页（假的 IndexedDB 全局串行事务 + BroadcastChannel 异步投递），
覆盖：状态一致性、<50ms 误差、并发开始/暂停幂等、暂停冻结、关闭重开恢复、倒计时自动完成。
