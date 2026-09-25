/* app.js — 浏览器端接线：IndexedDB 持久化 + BroadcastChannel 同步 + UI 渲染 */
(function () {
  'use strict';

  const DB_NAME = 'cross-tab-timer';
  const STORE = 'kv';
  const STATE_KEY = 'state';
  const CHANNEL_NAME = 'cross-tab-timer-v1';
  const RENDER_INTERVAL_MS = 33; // 约 30fps，后台被节流也不影响正确性（时间现算）

  /* ---------- IndexedDB 最小封装 ---------- */

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGet(db, key) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbSet(db, key, value) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /* ---------- 显示格式化 ---------- */

  function pad(n, len) {
    return String(n).padStart(len, '0');
  }

  function formatMs(ms) {
    const totalTenths = Math.ceil(ms / 100);
    const tenths = totalTenths % 10;
    const totalSeconds = Math.floor(totalTenths / 10);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const hms =
      hours > 0
        ? pad(hours, 2) + ':' + pad(minutes, 2) + ':' + pad(seconds, 2)
        : pad(minutes, 2) + ':' + pad(seconds, 2);
    return hms + '.' + tenths;
  }

  const STATUS_TEXT = {
    idle: '空闲',
    running: '运行中',
    paused: '已暂停',
    done: '已完成',
  };

  /* ---------- 启动 ---------- */

  async function main() {
    const db = await openDb();
    const storage = {
      load: () => idbGet(db, STATE_KEY),
      save: (state) => idbSet(db, STATE_KEY, state),
    };

    const timer = new SyncTimer({
      channel: new BroadcastChannel(CHANNEL_NAME),
      storage,
      onchange: render,
    });

    const el = {
      display: document.getElementById('display'),
      status: document.getElementById('status'),
      meta: document.getElementById('meta'),
      minutes: document.getElementById('minutes'),
      seconds: document.getElementById('seconds'),
      btnSet: document.getElementById('btn-set'),
      btnStart: document.getElementById('btn-start'),
      btnPause: document.getElementById('btn-pause'),
      btnReset: document.getElementById('btn-reset'),
    };

    function render() {
      el.display.textContent = formatMs(timer.remainingMs());
      el.display.dataset.status = timer.state.status;
      el.status.textContent = STATUS_TEXT[timer.state.status] || timer.state.status;
      el.meta.textContent =
        '标签页 ' + timer.tabId.slice(4, 10) + ' · 状态版本 v' + timer.state.version;
      el.btnStart.disabled = timer.state.status === 'running';
      el.btnPause.disabled = timer.state.status !== 'running';
    }

    el.btnStart.addEventListener('click', () => timer.start());
    el.btnPause.addEventListener('click', () => timer.pause());
    el.btnReset.addEventListener('click', () => timer.reset());
    el.btnSet.addEventListener('click', () => {
      const minutes = Math.max(0, parseInt(el.minutes.value, 10) || 0);
      const seconds = Math.max(0, parseInt(el.seconds.value, 10) || 0);
      const ms = (minutes * 60 + seconds) * 1000;
      if (ms > 0) timer.setDuration(ms);
    });

    await timer.init();
    render();

    // 渲染 + 到点检测 + 漂移校正的驱动循环。
    // 后台标签页会被浏览器节流，但时间由时钟现算，恢复后无跳变。
    setInterval(() => {
      timer.tick();
      render();
    }, RENDER_INTERVAL_MS);

    // 标签页从后台/冻结/离线恢复：立即重渲染并向其他标签页请求最新状态
    const resync = () => {
      if (document.hidden) return;
      timer.requestSync();
      timer.tick();
      render();
    };
    document.addEventListener('visibilitychange', resync);
    window.addEventListener('pageshow', resync);
    window.addEventListener('online', resync);
  }

  main().catch((err) => {
    document.getElementById('status').textContent = '初始化失败: ' + err.message;
  });
})();
