/*
 * 多标签页模拟测试（Node >= 18）
 *
 * 用 vm 为每个"标签页"创建独立上下文，注入假的 IndexedDB（全局串行化事务，
 * 模拟浏览器跨标签事务排队）、BroadcastChannel（异步投递）和 DOM stub，
 * 验证共享计时器的核心验收项。
 *
 * 运行: node test/simulate.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'shared-timer.js'), 'utf8');

// ---- 共享"浏览器"环境：所有标签页共用同一 origin 的 DB 与总线 ----
const sharedData = new Map();
let txChain = Promise.resolve();
const busChannels = [];

function processTx(tx) {
  return new Promise((resolve) => {
    const step = () => {
      if (tx.ops.length === 0) {
        tx.oncomplete && tx.oncomplete();
        resolve();
        return;
      }
      tx.ops.shift()();
      setTimeout(step, 0);
    };
    setTimeout(step, Math.random() * 2); // 模拟跨进程调度抖动
  });
}

const fakeIndexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      req.result = {
        transaction(_store, _mode) {
          const tx = { ops: [], oncomplete: null, onerror: null, onabort: null };
          tx.objectStore = () => ({
            get(key) {
              const r = {};
              tx.ops.push(() => { r.result = sharedData.get(key); r.onsuccess && r.onsuccess(); });
              return r;
            },
            put(value, key) {
              const r = {};
              tx.ops.push(() => { sharedData.set(key, structuredClone(value)); r.onsuccess && r.onsuccess(); });
              return r;
            },
          });
          txChain = txChain.then(() => processTx(tx)); // 事务全局串行
          return tx;
        },
      };
      req.onsuccess && req.onsuccess();
    }, 0);
    return req;
  },
};

class FakeBroadcastChannel {
  constructor(name) { this.name = name; busChannels.push(this); }
  postMessage(msg) {
    for (const c of busChannels) {
      if (c !== this && c.name === this.name && c.onmessage) {
        setTimeout(() => c.onmessage({ data: structuredClone(msg) }), Math.random() * 3);
      }
    }
  }
}

function makeElement() {
  return {
    textContent: '', value: '0', disabled: false,
    classList: { toggle() {} },
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    click() { this.listeners.click && this.listeners.click(); },
  };
}

function createTab() {
  const elements = new Map();
  const document = {
    hidden: false,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    addEventListener() {},
  };
  const context = {
    indexedDB: fakeIndexedDB,
    BroadcastChannel: FakeBroadcastChannel,
    document,
    performance,
    Date, Math, JSON, console, structuredClone,
    setTimeout,
    setInterval: () => 0,                    // 测试中不跑心跳/在线状态
    requestAnimationFrame: (cb) => setTimeout(cb, 16), // 驱动 tick 主循环
  };
  vm.createContext(context);
  vm.runInContext(src, context);
  return {
    context,
    el: (id) => document.getElementById(id),
    version: () => Number(document.getElementById('version').textContent),
    status: () => document.getElementById('status').textContent,
    time: () => document.getElementById('time').textContent,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, timeout = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting: ${what}`);
    await sleep(10);
  }
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}\n      ${e.message}`); }
}

// ---------------------------------------------------------------------------
const tabs = [createTab(), createTab(), createTab(), createTab()];
await waitFor(() => tabs.every((t) => t.status() === '空闲'), '4 tabs initialized');

await test('启动后 4 个标签页状态一致 (idle, v0)', () => {
  for (const t of tabs) assert.strictEqual(t.status(), '空闲');
});

tabs[0].el('startPauseBtn').click();
await waitFor(() => tabs.every((t) => t.status() === '运行中'), 'all tabs running');

await test('单点开始：4 个标签页同时进入运行中，版本一致', () => {
  const v = tabs[0].version();
  assert.strictEqual(v, 1);
  for (const t of tabs) assert.strictEqual(t.version(), v);
});

await test('运行中 4 个标签页显示时间一致 (误差 < 50ms)', async () => {
  await sleep(300);
  const parse = (s) => {
    const [m, rest] = s.split(':');
    const [sec, cs] = rest.split('.');
    return (+m) * 60000 + (+sec) * 1000 + (+cs) * 10;
  };
  const times = tabs.map((t) => parse(t.time()));
  const spread = Math.max(...times) - Math.min(...times);
  assert.ok(spread < 50, `spread ${spread}ms >= 50ms`);
});

await test('两个标签页同时暂停：只生效一次，版本只 +1', async () => {
  const v0 = tabs[0].version();
  tabs[1].el('startPauseBtn').click(); // 运行中 -> 暂停
  tabs[2].el('startPauseBtn').click(); // 并发暂停，应幂等丢弃
  await waitFor(() => tabs.every((t) => t.status() === '已暂停'), 'all paused');
  await sleep(50);
  for (const t of tabs) assert.strictEqual(t.version(), v0 + 1);
});

await test('暂停后时间冻结且一致', async () => {
  const t0 = tabs.map((t) => t.time());
  await sleep(200);
  const t1 = tabs.map((t) => t.time());
  assert.deepStrictEqual(t0, t1);
});

await test('重置后两个标签页同时开始：只生效一次', async () => {
  tabs[0].el('resetBtn').click();
  await waitFor(() => tabs.every((t) => t.status() === '空闲'), 'all idle');
  const v0 = tabs[0].version();
  tabs[0].el('startPauseBtn').click();
  tabs[3].el('startPauseBtn').click(); // 并发开始
  await waitFor(() => tabs.every((t) => t.status() === '运行中'), 'all running again');
  await sleep(50);
  for (const t of tabs) assert.strictEqual(t.version(), v0 + 1);
});

await test('全部"关闭"后重开新标签页：状态从 IndexedDB 恢复且继续计时', async () => {
  await sleep(200);
  const reopened = createTab(); // 旧标签页 GC 等价物：新上下文读同一 DB
  await waitFor(() => reopened.status() === '运行中', 'reopened tab running');
  assert.strictEqual(reopened.version(), tabs[0].version());
  const parse = (s) => {
    const [m, rest] = s.split(':');
    const [sec, cs] = rest.split('.');
    return (+m) * 60000 + (+sec) * 1000 + (+cs) * 10;
  };
  const spread = Math.abs(parse(reopened.time()) - parse(tabs[0].time()));
  assert.ok(spread < 50, `reopened spread ${spread}ms >= 50ms`);
});

await test('倒计时结束自动置为已完成', async () => {
  tabs[0].el('resetBtn').click();
  await waitFor(() => tabs.every((t) => t.status() === '空闲'), 'idle before set');
  tabs[0].el('minutesInput').value = '0';
  tabs[0].el('secondsInput').value = '1';
  tabs[0].el('setDurationBtn').click();
  await waitFor(() => tabs.every((t) => t.time() === '00:01.00'), 'duration set to 1s');
  tabs[0].el('startPauseBtn').click();
  await waitFor(() => tabs.every((t) => t.status() === '已完成'), 'all finished', 5000);
  // finishTimer 由 tick 驱动，但 rAF 被 stub —— 直接验证状态已收敛
  for (const t of tabs) assert.strictEqual(t.time(), '00:00.00');
});

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
