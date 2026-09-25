/*
 * 集成测试：在 Node 中用真实 BroadcastChannel + 虚拟时钟模拟 4 个标签页。
 * 运行：node test/sync-timer.test.mjs
 */
import pkg from '../sync-timer.js';
const { SyncTimer, LocalClock } = pkg;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 60;

let channelSeq = 0;
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.error('  ✗ ' + name + '\n    ' + err.message);
  }
}

/* 虚拟时间：perf 单调，wall 可独立跳变以模拟系统时钟漂移 */
function makeVirtualTime() {
  return {
    perf: 1_000_000,
    wall: 1_700_000_000_000,
    advance(ms) {
      this.perf += ms;
      this.wall += ms;
    },
    jumpWall(ms) {
      this.wall += ms;
    },
  };
}

/* 共享对象模拟同源 IndexedDB（last-write-wins） */
function makeSharedDb() {
  return { data: null };
}

function makeStorage(db) {
  return {
    async load() {
      return db.data ? JSON.parse(JSON.stringify(db.data)) : null;
    },
    async save(state) {
      db.data = JSON.parse(JSON.stringify(state));
    },
  };
}

function makeTab(vt, db, channelName, tabId, skewMs = 0) {
  const channel = new BroadcastChannel(channelName);
  const timer = new SyncTimer({
    tabId,
    channel,
    storage: makeStorage(db),
    clock: new LocalClock({
      wallNow: () => vt.wall + skewMs,
      perfNow: () => vt.perf,
    }),
  });
  return timer;
}

async function makeTabs(vt, db, channelName, skews) {
  const tabs = skews.map((skew, i) => makeTab(vt, db, channelName, 'tab-' + i, skew));
  for (const t of tabs) await t.init();
  await sleep(SETTLE_MS);
  return tabs;
}

function closeAll(tabs) {
  for (const t of tabs) t.close();
}

function assertConverged(tabs, what = '状态') {
  const snapshot = (t) =>
    JSON.stringify({
      status: t.state.status,
      durationMs: t.state.durationMs,
      accumulatedMs: t.state.accumulatedMs,
      startedAtWallMs: t.state.startedAtWallMs,
      version: t.state.version,
      updatedBy: t.state.updatedBy,
    });
  const first = snapshot(tabs[0]);
  for (const t of tabs) {
    assert(snapshot(t) === first, what + '未收敛: ' + snapshot(t) + ' !== ' + first);
  }
}

function maxSpread(values) {
  return Math.max(...values) - Math.min(...values);
}

/* ---------------- 测试 ---------------- */

console.log('跨标签页同步计时器测试\n');

await test('4 个标签页时间一致，误差 < 50ms', async () => {
  const vt = makeVirtualTime();
  const db = makeSharedDb();
  const ch = 'ch-' + channelSeq++;
  const tabs = await makeTabs(vt, db, ch, [-10, -3, 4, 10]); // 模拟各标签页微小钟差

  tabs[0].setDuration(10 * 60 * 1000);
  await sleep(SETTLE_MS);
  tabs[1].start();
  await sleep(SETTLE_MS);
  vt.advance(123456);

  const readings = tabs.map((t) => t.remainingMs());
  const spread = maxSpread(readings);
  assert(spread < 50, '标签页间误差 ' + spread + 'ms >= 50ms');
  assert(tabs.every((t) => t.state.status === 'running'), '应全部处于运行中');
  closeAll(tabs);
});

await test('同时开始不冲突（并发 start 收敛）', async () => {
  const vt = makeVirtualTime();
  const db = makeSharedDb();
  const ch = 'ch-' + channelSeq++;
  const tabs = await makeTabs(vt, db, ch, [0, 0, 0, 0]);

  tabs[0].setDuration(5 * 60 * 1000);
  await sleep(SETTLE_MS);
  // 同一时刻两个标签页各自点“开始”（消息尚未送达对方）
  tabs[0].start();
  tabs[2].start();
  await sleep(SETTLE_MS);

  assertConverged(tabs, '并发开始');
  assert(tabs[0].state.status === 'running', '应处于运行中');
  closeAll(tabs);
});

await test('同时暂停不冲突（并发 pause 收敛）', async () => {
  const vt = makeVirtualTime();
  const db = makeSharedDb();
  const ch = 'ch-' + channelSeq++;
  const tabs = await makeTabs(vt, db, ch, [0, 0, 0, 0]);

  tabs[0].setDuration(5 * 60 * 1000);
  await sleep(SETTLE_MS);
  tabs[1].start();
  await sleep(SETTLE_MS);
  vt.advance(5000);
  tabs[0].pause();
  tabs[3].pause();
  await sleep(SETTLE_MS);

  assertConverged(tabs, '并发暂停');
  assert(tabs[0].state.status === 'paused', '应处于暂停');
  const r0 = tabs[0].remainingMs();
  vt.advance(10000); // 暂停期间时间流逝
  assert(tabs.every((t) => t.remainingMs() === r0), '暂停后剩余时间不应变化');
  closeAll(tabs);
});

await test('开始与重置并发也不冲突', async () => {
  const vt = makeVirtualTime();
  const db = makeSharedDb();
  const ch = 'ch-' + channelSeq++;
  const tabs = await makeTabs(vt, db, ch, [0, 0, 0, 0]);

  tabs[0].setDuration(5 * 60 * 1000);
  await sleep(SETTLE_MS);
  tabs[0].start();
  await sleep(SETTLE_MS);
  vt.advance(2000);
  tabs[0].pause();
  await sleep(SETTLE_MS);
  tabs[1].start(); // 继续
  tabs[2].reset(); // 同时重置
  await sleep(SETTLE_MS);

  assertConverged(tabs, '开始/重置并发');
  closeAll(tabs);
});

await test('标签页关闭后计时不丢，重开后续跑', async () => {
  const vt = makeVirtualTime();
  const db = makeSharedDb();
  const ch = 'ch-' + channelSeq++;
  const tabs = await makeTabs(vt, db, ch, [0, 0, 0, 0]);

  tabs[0].setDuration(60 * 1000);
  await sleep(SETTLE_MS);
  tabs[0].start();
  await sleep(SETTLE_MS);
  vt.advance(7000);

  // 关闭全部标签页（模拟浏览器整个关掉）
  closeAll(tabs);
  vt.advance(30000); // 关闭期间时间继续流逝

  // 重新打开一个标签页：仅从 IndexedDB 恢复
  const reopened = makeTab(vt, db, ch, 'tab-new', 0);
  await reopened.init();
  await sleep(SETTLE_MS);

  const remaining = reopened.remainingMs();
  const expected = 60000 - 7000 - 30000;
  assert(
    Math.abs(remaining - expected) < 50,
    `恢复后剩余 ${remaining}ms，期望约 ${expected}ms`
  );
  assert(reopened.state.status === 'running', '重开后应仍在运行');
  reopened.close();
});

await test('时钟漂移可校正（系统时钟跳变 +5s）', async () => {
  const vt = makeVirtualTime();
  const db = makeSharedDb();
  const ch = 'ch-' + channelSeq++;
  const tabs = await makeTabs(vt, db, ch, [0, 0, 0, 0]);

  tabs[0].setDuration(60 * 1000);
  await sleep(SETTLE_MS);
  tabs[0].start();
  await sleep(SETTLE_MS);
  vt.advance(10000);
  const before = tabs[0].remainingMs();

  vt.jumpWall(5000); // 系统时钟突然快 5 秒
  const jump = tabs[0].correctDrift(); // 某个标签页检测到漂移并校正
  assert(jump === 5000, '应检测到 5000ms 跳变，实际 ' + jump);
  await sleep(SETTLE_MS);

  assertConverged(tabs, '漂移校正后');
  for (const t of tabs) {
    const drift = Math.abs(t.remainingMs() - before);
    assert(drift < 50, '校正后剩余时间跳变 ' + drift + 'ms >= 50ms');
  }
  // 校正后计时继续正常
  vt.advance(3000);
  const after = tabs[2].remainingMs();
  assert(Math.abs(after - (before - 3000)) < 50, '校正后计时不连续');
  closeAll(tabs);
});

await test('后台节流后恢复不跳变（时间现算，不靠定时器累计）', async () => {
  const vt = makeVirtualTime();
  const db = makeSharedDb();
  const ch = 'ch-' + channelSeq++;
  const tabs = await makeTabs(vt, db, ch, [0, 0, 0, 0]);

  tabs[0].setDuration(60 * 1000);
  await sleep(SETTLE_MS);
  tabs[0].start();
  await sleep(SETTLE_MS);

  // 模拟后台节流：长时间没有任何 tick/渲染，只流逝时间
  vt.advance(45000);
  // 回到前台，第一次渲染
  const remaining = tabs[1].remainingMs();
  const expected = 60000 - 45000;
  assert(
    Math.abs(remaining - expected) < 50,
    `节流恢复后剩余 ${remaining}ms，期望约 ${expected}ms`
  );
  closeAll(tabs);
});

await test('刷新任意标签页后时间一致', async () => {
  const vt = makeVirtualTime();
  const db = makeSharedDb();
  const ch = 'ch-' + channelSeq++;
  const tabs = await makeTabs(vt, db, ch, [0, 0, 0, 0]);

  tabs[0].setDuration(60 * 1000);
  await sleep(SETTLE_MS);
  tabs[2].start();
  await sleep(SETTLE_MS);
  vt.advance(8000);
  tabs[1].pause();
  await sleep(SETTLE_MS);

  // 刷新 tabs[3]：关闭并用同一存储重建
  tabs[3].close();
  const refreshed = makeTab(vt, db, ch, 'tab-3b', 0);
  await refreshed.init();
  await sleep(SETTLE_MS);
  tabs[3] = refreshed;

  assertConverged(tabs, '刷新后');
  const spread = maxSpread(tabs.map((t) => t.remainingMs()));
  assert(spread < 50, '刷新后标签页间误差 ' + spread + 'ms >= 50ms');
  closeAll(tabs);
});

await test('倒计时到点自动完成并同步', async () => {
  const vt = makeVirtualTime();
  const db = makeSharedDb();
  const ch = 'ch-' + channelSeq++;
  const tabs = await makeTabs(vt, db, ch, [0, 0, 0, 0]);

  tabs[0].setDuration(3000);
  await sleep(SETTLE_MS);
  tabs[1].start();
  await sleep(SETTLE_MS);
  vt.advance(3500);
  tabs[2].tick(); // 某个标签页的渲染循环检测到到点
  await sleep(SETTLE_MS);

  assertConverged(tabs, '到点完成');
  assert(tabs[0].state.status === 'done', '应为已完成');
  assert(tabs.every((t) => t.remainingMs() === 0), '剩余应为 0');
  closeAll(tabs);
});

await test('暂停-继续累计正确', async () => {
  const vt = makeVirtualTime();
  const db = makeSharedDb();
  const ch = 'ch-' + channelSeq++;
  const tabs = await makeTabs(vt, db, ch, [0, 0, 0, 0]);

  tabs[0].setDuration(100000);
  await sleep(SETTLE_MS);
  tabs[0].start();
  await sleep(SETTLE_MS);
  vt.advance(10000);
  tabs[1].pause();
  await sleep(SETTLE_MS);
  vt.advance(99999); // 暂停期间不计时
  tabs[2].start(); // 继续
  await sleep(SETTLE_MS);
  vt.advance(5000);

  const expected = 100000 - 10000 - 5000;
  for (const t of tabs) {
    assert(
      Math.abs(t.remainingMs() - expected) < 50,
      `剩余 ${t.remainingMs()}ms，期望约 ${expected}ms`
    );
  }
  closeAll(tabs);
});

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
