# 跨标签页同步计时器

在多个浏览器标签页之间共享的倒计时器：开始、暂停、重置、设置时长，所有标签页时间一致。
只做计时和同步——没有任务、历史、提醒。

## 运行

```bash
python3 -m http.server 8000
# 打开 4 个标签页：http://localhost:8000
```

> 必须通过 http(s) 或 localhost 访问，`file://` 下各标签页不共享 IndexedDB 源。

## 技术方案

- **BroadcastChannel**：状态变更的实时广播（低延迟，标签页间直接通信）。
- **IndexedDB**：唯一持久化真相。标签页关闭、刷新、离线后从这里恢复；运行中的计时由时间锚点推算，关闭期间照常"走表"。
- **performance.now()**：本地单调时钟。显示的时间永远由时钟现算（`accumulatedMs + (now - startedAtWallMs)`），不靠 `setInterval` 累计，因此后台节流不丢时间、恢复不跳变。

### 一致性设计

- **冲突解决**：Last-Writer-Wins。每次变更 `version + 1`；并发变更产生相同 version 时，按 `updatedBy`（标签页 ID）字典序取大者。所有标签页结论一致，必然收敛。
- **时钟漂移**：本地用 `performance.now()` 估计墙钟，每秒检测一次系统时钟跳变（>500ms）。发现跳变时 rebase 本地时钟，并把共享锚点平移相同量，广播后全部标签页收敛，计时连续。
- **后台节流 / 恢复**：`visibilitychange` / `pageshow` / `online` 时立即重渲染并广播 `hello` 请求最新状态。

## 文件

| 文件 | 说明 |
| --- | --- |
| `sync-timer.js` | 同步核心（状态机 + LWW + 单调时钟），浏览器/Node 通用 |
| `app.js` | 浏览器接线：IndexedDB 封装、渲染循环、事件绑定 |
| `index.html` / `style.css` | 页面 |
| `test/sync-timer.test.mjs` | Node 集成测试（真实 BroadcastChannel + 虚拟时钟模拟 4 标签页） |

## 测试

```bash
node test/sync-timer.test.mjs
```

## 验收对照

| 验收标准 | 保障机制 | 对应测试 |
| --- | --- | --- |
| 4 标签页误差 < 50ms | 同一系统墙钟 + 同一时间锚点现算 | `4 个标签页时间一致` |
| 同时开始/暂停不冲突 | version + tabId 的 LWW 确定性收敛 | `同时开始/同时暂停/开始与重置并发` |
| 标签页关闭不丢计时 | IndexedDB 持久化 + 锚点推算 | `标签页关闭后计时不丢` |
| 离线恢复后时间正确 | 恢复时读 IndexedDB + `hello` 请求最新状态 | `标签页关闭后计时不丢`、`刷新任意标签页` |
| 时钟漂移可校正 | 跳变检测 + 锚点平移 + 广播收敛 | `时钟漂移可校正` |
| 后台节流恢复不跳变 | 时间由时钟现算，不靠定时器累计 | `后台节流后恢复不跳变` |
| 刷新后时间一致 | IndexedDB 恢复 + 广播同步 | `刷新任意标签页后时间一致` |
