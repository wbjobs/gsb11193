/*
 * sync-timer.js — 跨标签页倒计时同步核心。
 *
 * 同步模型：
 *  - 共享状态只有一份逻辑拷贝，存 IndexedDB（持久化），变更经 BroadcastChannel 广播（低延迟）。
 *  - 冲突解决：Last-Writer-Wins。version 大的胜；version 相同（并发突变）时 updatedBy 字典序大的胜。
 *    所有标签页对同一对 (version, updatedBy) 得出相同结论，因此必然收敛。
 *  - 时间计算：运行中 elapsed = accumulatedMs + (本地单调时钟 - startedAtWallMs)。
 *    显示值永远由时钟现算，不依赖定时器累计，因此后台节流不会丢时间、恢复不跳变。
 *  - 时钟漂移：LocalClock 用 performance.now() 估计墙钟。检测到系统时钟跳变 (>500ms) 时，
 *    本地时钟 rebase，并把共享锚点 startedAtWallMs 平移相同量，经过广播后所有标签页收敛。
 */
(function (global) {
  'use strict';

  const DRIFT_THRESHOLD_MS = 500;
  const DRIFT_CHECK_INTERVAL_MS = 1000;

  const DEFAULT_STATE = Object.freeze({
    status: 'idle', // idle | running | paused | done
    durationMs: 10 * 60 * 1000,
    accumulatedMs: 0, // 当前运行段之前已累计的耗时
    startedAtWallMs: null, // 当前运行段的起始墙钟锚点
    version: 0,
    updatedBy: '',
    updatedAtWallMs: 0,
  });

  function randomTabId() {
    return 'tab-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
  }

  /* 本地单调时钟：performance.now() 为骨架，墙钟为基准，可检测系统时钟跳变。 */
  class LocalClock {
    constructor(opts = {}) {
      this._wall = opts.wallNow || (() => Date.now());
      this._perf = opts.perfNow || (() => performance.now());
      this._wallBase = this._wall();
      this._perfBase = this._perf();
    }
    now() {
      return this._wallBase + (this._perf() - this._perfBase);
    }
    // 系统墙钟相对单调时钟的跳变量（无跳变时约为 0）
    detectJump() {
      const expected = this._wallBase + (this._perf() - this._perfBase);
      return this._wall() - expected;
    }
    rebase() {
      this._wallBase = this._wall();
      this._perfBase = this._perf();
    }
  }

  class SyncTimer {
    /**
     * @param {object} opts
     * @param {object} opts.channel  BroadcastChannel 或同构对象 {postMessage, onmessage, close?}
     * @param {object} opts.storage  {load(): Promise<state|null>, save(state): Promise<void>}
     * @param {LocalClock} [opts.clock]
     * @param {string} [opts.tabId]
     * @param {function} [opts.onchange] 状态被本地修改或远端采纳后回调
     */
    constructor(opts = {}) {
      this.tabId = opts.tabId || randomTabId();
      this.clock = opts.clock || new LocalClock();
      this.channel = opts.channel || null;
      this.storage = opts.storage || null;
      this.onchange = opts.onchange || (() => {});
      this.state = Object.assign({}, DEFAULT_STATE);
      this._lastDriftCheckPerf = this._perfNow();
      if (this.channel) {
        this.channel.onmessage = (ev) => {
          const msg = ev && ev.data !== undefined ? ev.data : ev;
          this._onMessage(msg);
        };
      }
    }

    _perfNow() {
      return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }

    async init() {
      if (this.storage) {
        const saved = await this.storage.load();
        if (saved && typeof saved.version === 'number') {
          this.state = Object.assign({}, DEFAULT_STATE, saved);
        }
      }
      this.requestSync(); // 向其他标签页要最新状态，覆盖本地可能过期的持久化
      this.onchange(this.state);
      return this.state;
    }

    close() {
      if (this.channel && typeof this.channel.close === 'function') this.channel.close();
    }

    requestSync() {
      this._post({ type: 'hello', tabId: this.tabId });
    }

    /* ---------- 只读计算 ---------- */

    elapsedMs(now = this.clock.now()) {
      const s = this.state;
      let e = s.accumulatedMs;
      if (s.status === 'running' && s.startedAtWallMs != null) {
        e += now - s.startedAtWallMs;
      }
      return Math.max(0, e);
    }

    remainingMs(now = this.clock.now()) {
      return Math.max(0, this.state.durationMs - this.elapsedMs(now));
    }

    /* ---------- 用户操作 ---------- */

    start() {
      if (this.state.status === 'running') return;
      this._mutate((s, now) => {
        if (s.status === 'done' || s.accumulatedMs >= s.durationMs) s.accumulatedMs = 0;
        s.startedAtWallMs = now;
        s.status = 'running';
      });
    }

    pause() {
      if (this.state.status !== 'running') return;
      this._mutate((s, now) => {
        s.accumulatedMs = Math.max(0, s.accumulatedMs + (now - s.startedAtWallMs));
        s.startedAtWallMs = null;
        s.status = 'paused';
      });
    }

    reset() {
      this._mutate((s) => {
        s.status = 'idle';
        s.accumulatedMs = 0;
        s.startedAtWallMs = null;
      });
    }

    setDuration(ms) {
      if (!(ms > 0)) return;
      this._mutate((s) => {
        s.durationMs = Math.round(ms);
        s.status = 'idle';
        s.accumulatedMs = 0;
        s.startedAtWallMs = null;
      });
    }

    /* 由 UI 的渲染循环周期性调用：处理到点完成 + 节流地进行漂移校正 */
    tick() {
      if (this.state.status === 'running' && this.remainingMs() <= 0) {
        this._mutate((s) => {
          s.status = 'done';
          s.accumulatedMs = s.durationMs;
          s.startedAtWallMs = null;
        });
      }
      const nowPerf = this._perfNow();
      if (nowPerf - this._lastDriftCheckPerf >= DRIFT_CHECK_INTERVAL_MS) {
        this._lastDriftCheckPerf = nowPerf;
        this.correctDrift();
      }
    }

    /* 系统时钟跳变校正：rebase 本地时钟并平移共享锚点，返回跳变量（无跳变返回 0） */
    correctDrift() {
      const jump = this.clock.detectJump();
      if (Math.abs(jump) < DRIFT_THRESHOLD_MS) return 0;
      this.clock.rebase();
      if (this.state.status === 'running') {
        this._mutate((s) => {
          s.startedAtWallMs += jump;
        });
      }
      return jump;
    }

    /* ---------- 内部 ---------- */

    _mutate(fn) {
      const s = Object.assign({}, this.state);
      fn(s, this.clock.now());
      s.version = this.state.version + 1;
      s.updatedBy = this.tabId;
      s.updatedAtWallMs = Date.now();
      this._apply(s);
      this._persist();
      this._post({ type: 'state', state: this.state });
    }

    _apply(s) {
      this.state = s;
      this.onchange(this.state);
    }

    _persist() {
      if (this.storage) {
        Promise.resolve(this.storage.save(this.state)).catch(() => {});
      }
    }

    _post(msg) {
      if (this.channel) {
        try {
          this.channel.postMessage(msg);
        } catch (_) {
          /* 频道已关闭等情况忽略 */
        }
      }
    }

    _onMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello') {
        this._post({ type: 'state', state: this.state });
        return;
      }
      if (msg.type === 'state' && msg.state && typeof msg.state.version === 'number') {
        if (SyncTimer.shouldAdopt(this.state, msg.state)) {
          this._apply(msg.state);
          // 远端锚点以当前墙钟尺度解释；rebase 让本地单调时钟对齐墙钟，
          // 同时吸收本地尚未处理的时钟跳变，避免重复校正。
          this.clock.rebase();
          this._persist();
        }
      }
    }

    // Last-Writer-Wins：version 大者胜；并列时 updatedBy 字典序大者胜（确定性收敛）
    static shouldAdopt(local, remote) {
      if (remote.version !== local.version) return remote.version > local.version;
      if (remote.updatedBy !== local.updatedBy) return remote.updatedBy > local.updatedBy;
      return false;
    }
  }

  const api = { SyncTimer, LocalClock, DEFAULT_STATE, DRIFT_THRESHOLD_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SyncTimer = SyncTimer;
  global.LocalClock = LocalClock;
  global.SYNC_TIMER_DEFAULT_STATE = DEFAULT_STATE;
})(typeof window !== 'undefined' ? window : globalThis);
