/*
 * 多标签页共享计时器
 *
 * 技术栈: BroadcastChannel（实时同步）+ IndexedDB（持久化 / 原子写）+ performance.now()（本地单调渲染）
 *
 * 核心设计:
 * 1. 锚点计时 —— 共享状态只保存「累计时长 baseElapsedMs + 运行段起点墙钟 anchorWallMs」，
 *    各标签页把墙钟锚点映射到本地 performance.now() 后纯本地推算。
 *    => 后台节流、刷新、关闭标签页、离线恢复都不会丢失或跳变。
 * 2. 原子变更 —— 所有操作在单个 IndexedDB readwrite 事务内 read-modify-write，
 *    跨标签事务被浏览器串行化，配合单调递增 version，同时开始/暂停天然幂等。
 * 3. 时钟漂移校正 —— 广播消息携带发送方墙钟，接收方用 EMA 估计时钟偏移；
 *    运行中每秒比对 wall/perf 双钟，系统时钟跳变超过阈值时自动重锚定。
 */
'use strict';

const DB_NAME = 'shared-timer';
const STORE_NAME = 'kv';
const STATE_KEY = 'timer-state';
const CHANNEL_NAME = 'shared-timer-v1';
const TAB_ID = Math.random().toString(36).slice(2, 8);
const DEFAULT_DURATION_MS = 5 * 60 * 1000;

const HEARTBEAT_INTERVAL_MS = 1000;   // 运行中广播心跳，供漂移校正与迟到标签页同步
const PRESENCE_INTERVAL_MS = 2000;    // 在线状态广播
const PEER_TTL_MS = 5000;
const WALL_JUMP_THRESHOLD_MS = 250;   // wall/perf 双钟偏差超过该值时重锚定

function defaultState() {
  return {
    status: 'idle',          // idle | running | paused | finished
    durationMs: DEFAULT_DURATION_MS,
    baseElapsedMs: 0,        // 最近一个锚点之前已累计的毫秒
    anchorWallMs: null,      // 当前运行段起点（写入方墙钟），仅 running 时有效
    version: 0,              // 单调递增，解决并发冲突
    updatedBy: null,
  };
}

// ---------------------------------------------------------------------------
// 本地运行时
// ---------------------------------------------------------------------------
let state = defaultState();
let anchorPerfMs = null;     // state.anchorWallMs 映射到本地 performance 时钟的时间点
let clockOffsetMs = 0;       // 估计的「其他标签页时钟 - 本地时钟」偏移（EMA）
let offsetInitialized = false;
const peers = new Map();     // tabId -> lastSeen

function correctedNow() {
  return Date.now() + clockOffsetMs;
}

// 把墙钟锚点映射到本地单调时钟；之后渲染只依赖 performance.now()
function reanchor() {
  if (state.status === 'running' && state.anchorWallMs != null) {
    anchorPerfMs = performance.now() - (correctedNow() - state.anchorWallMs);
  } else {
    anchorPerfMs = null;
  }
}

function elapsedMs() {
  if (state.status === 'running' && anchorPerfMs != null) {
    return state.baseElapsedMs + (performance.now() - anchorPerfMs);
  }
  return state.baseElapsedMs;
}

function remainingMs() {
  return Math.max(0, state.durationMs - elapsedMs());
}

function updateClockOffset(remoteWallMs) {
  const sample = remoteWallMs - Date.now();
  // BroadcastChannel 同进程投递延迟通常 <5ms，直接采样即可
  clockOffsetMs = offsetInitialized
    ? clockOffsetMs * 0.8 + sample * 0.2
    : sample;
  offsetInitialized = true;
}

// ---------------------------------------------------------------------------
// IndexedDB：单事务 read-modify-write，跨标签原子
// ---------------------------------------------------------------------------
let db = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readState() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(STATE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// mutator(current) 返回新状态；返回 null 表示无操作（幂等冲突时丢弃）
function mutate(mutator) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(STATE_KEY);
    let next = null;
    getReq.onsuccess = () => {
      const current = getReq.result || defaultState();
      next = mutator(current);
      if (next) {
        next.version = current.version + 1;
        next.updatedBy = TAB_ID;
        store.put(next, STATE_KEY);
      }
    };
    tx.oncomplete = () => resolve(next);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// 操作（全部幂等，并发安全）
// ---------------------------------------------------------------------------
async function commitAndBroadcast(mutator) {
  const committed = await mutate(mutator);
  if (committed) {
    applyState(committed);
    broadcast('state');
  }
}

function startTimer() {
  return commitAndBroadcast((s) => {
    if (s.status === 'running') return null;              // 同时开始：后到者丢弃
    if (s.status === 'idle' || s.status === 'finished') s.baseElapsedMs = 0;
    s.status = 'running';
    s.anchorWallMs = correctedNow();
    return s;
  });
}

function pauseTimer() {
  return commitAndBroadcast((s) => {
    if (s.status !== 'running') return null;              // 同时暂停：后到者丢弃
    s.baseElapsedMs += correctedNow() - s.anchorWallMs;
    s.anchorWallMs = null;
    s.status = 'paused';
    return s;
  });
}

function resetTimer() {
  return commitAndBroadcast((s) => {
    if (s.status === 'idle' && s.baseElapsedMs === 0) return null;
    s.status = 'idle';
    s.baseElapsedMs = 0;
    s.anchorWallMs = null;
    return s;
  });
}

function setDuration(durationMs) {
  return commitAndBroadcast((s) => {
    if (s.status === 'running') return null;              // 运行中不允许改时长
    if (s.durationMs === durationMs && s.status === 'idle' && s.baseElapsedMs === 0) return null;
    s.durationMs = durationMs;
    s.baseElapsedMs = 0;
    s.anchorWallMs = null;
    s.status = 'idle';
    return s;
  });
}

// 倒计时结束：任何标签页发现后提交，version 保证只生效一次
function finishTimer() {
  return commitAndBroadcast((s) => {
    if (s.status !== 'running') return null;
    s.baseElapsedMs = s.durationMs;
    s.anchorWallMs = null;
    s.status = 'finished';
    return s;
  });
}

// ---------------------------------------------------------------------------
// BroadcastChannel：状态广播 / 心跳 / 在线状态
// ---------------------------------------------------------------------------
const channel = new BroadcastChannel(CHANNEL_NAME);

function broadcast(type) {
  channel.postMessage({
    type,
    tabId: TAB_ID,
    sentWallMs: Date.now(),
    state: type === 'state' || type === 'heartbeat' ? state : undefined,
  });
}

channel.onmessage = (event) => {
  const msg = event.data;
  if (!msg || msg.tabId === TAB_ID) return;
  peers.set(msg.tabId, Date.now());
  if (msg.sentWallMs) updateClockOffset(msg.sentWallMs);

  switch (msg.type) {
    case 'state':
    case 'heartbeat':
      // 只接受更高版本，过期/重复消息直接忽略
      if (msg.state && msg.state.version > state.version) applyState(msg.state);
      break;
    case 'sync-request':
      broadcast('state');   // 新标签页/刷新后请求全量状态
      break;
    case 'presence':
      break;
  }
};

function applyState(next) {
  state = next;
  reanchor();
  render();
}

// ---------------------------------------------------------------------------
// 渲染：时间永远由时钟推算，不靠计数累加 —— 节流后恢复零跳变
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const timeEl = el('time');
const statusEl = el('status');
const startPauseBtn = el('startPauseBtn');

function formatMs(ms) {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const centis = Math.floor((total % 1000) / 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(minutes)}:${pad(seconds)}.${pad(centis)}`;
}

const STATUS_TEXT = { idle: '空闲', running: '运行中', paused: '已暂停', finished: '已完成' };

function render() {
  timeEl.textContent = formatMs(remainingMs());
  timeEl.classList.toggle('finished', state.status === 'finished');
  statusEl.textContent = STATUS_TEXT[state.status];
  startPauseBtn.textContent = state.status === 'running' ? '暂停' : '开始';
  el('version').textContent = state.version;
  el('updatedBy').textContent = state.updatedBy || '-';
  el('offset').textContent = clockOffsetMs.toFixed(1);
  el('minutesInput').disabled = state.status === 'running';
  el('secondsInput').disabled = state.status === 'running';
  el('setDurationBtn').disabled = state.status === 'running';
}

function renderPeers() {
  const now = Date.now();
  for (const [id, seen] of peers) if (now - seen > PEER_TTL_MS) peers.delete(id);
  el('peers').textContent = peers.size + 1;
}

// 主循环：可见时用 rAF，后台用低频 setTimeout（时间由时钟推算，频率不影响精度）
function tick() {
  // 系统时钟跳变检测：wall 与 perf 双钟推算结果偏差过大则重锚定
  if (state.status === 'running' && anchorPerfMs != null) {
    const wallElapsed = correctedNow() - state.anchorWallMs;
    const perfElapsed = performance.now() - anchorPerfMs;
    if (Math.abs(wallElapsed - perfElapsed) > WALL_JUMP_THRESHOLD_MS) reanchor();
  }
  if (state.status === 'running' && remainingMs() <= 0) finishTimer();
  render();
  if (document.hidden) setTimeout(tick, 500);
  else requestAnimationFrame(tick);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();   // 回到前台立即刷新，无跳变
});

// ---------------------------------------------------------------------------
// UI 事件
// ---------------------------------------------------------------------------
startPauseBtn.addEventListener('click', () => {
  if (state.status === 'running') pauseTimer();
  else startTimer();
});
el('resetBtn').addEventListener('click', resetTimer);
el('setDurationBtn').addEventListener('click', () => {
  const minutes = Math.max(0, Number(el('minutesInput').value) || 0);
  const seconds = Math.min(59, Math.max(0, Number(el('secondsInput').value) || 0));
  const durationMs = (minutes * 60 + seconds) * 1000;
  if (durationMs > 0) setDuration(durationMs);
});

// ---------------------------------------------------------------------------
// 启动：IndexedDB 恢复状态（关标签页/刷新/离线恢复）+ 广播请求最新状态
// ---------------------------------------------------------------------------
(async function init() {
  el('tabId').textContent = TAB_ID;
  db = await openDb();
  const persisted = await readState();
  if (persisted) applyState(persisted);
  broadcast('sync-request');
  setInterval(() => {
    broadcast('presence');
    renderPeers();
  }, PRESENCE_INTERVAL_MS);
  setInterval(() => { if (state.status === 'running' && !document.hidden) broadcast('heartbeat'); }, HEARTBEAT_INTERVAL_MS);
  render();
  tick();
})();
