/**
 * Per-session append-only PTY log writer.
 *
 * Lives on disk at `data/buffers/{sessionId}.log` — raw PTY bytes (with
 * ANSI; alt-screen toggles already stripped at terminal-manager.js:435).
 * Survives PM2 worker restarts, tmux server crashes, VPS reboots.
 *
 * Hard cap 50 MB per session. On overflow: async truncate-and-shift keeps
 * newest 25 MB at next `\n` boundary within 64 KB of the cut point. Older
 * bytes are dropped permanently (per architect decision: ≥50 MB is
 * acceptable history loss).
 *
 * Write batching: hybrid 100 ms / 64 KB / 250 ms-deadline to avoid
 * per-chunk syscalls under 30 fps Claude redraws while keeping latency
 * bounded.
 *
 * Errors NEVER throw to the PTY data flow — all I/O is try/catch wrapped
 * with a console.warn fallback.
 */
const fs = require("fs");
const path = require("path");

const BUFFERS_DIR = path.join(__dirname, "..", "data", "buffers");
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ROTATE_KEEP = 25 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 100;
const FLUSH_DEADLINE_MS = 250;
const FLUSH_BYTE_THRESHOLD = 64 * 1024;
const ROTATE_PROBE_BYTES = 64 * 1024;

try {
  fs.mkdirSync(BUFFERS_DIR, { recursive: true });
} catch {
  /* dir creation is best-effort */
}

class HistoryLog {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.path = path.join(BUFFERS_DIR, `${sessionId}.log`);
    this.stream = null;
    this.pending = [];
    this.pendingSize = 0;
    this.flushTimer = null;
    this.deadlineTimer = null;
    this._closed = false;
    this._rotating = false;
    try {
      this._currentSize = fs.statSync(this.path).size;
    } catch {
      this._currentSize = 0;
    }
  }

  _openStream() {
    if (this.stream || this._closed) return;
    try {
      this.stream = fs.createWriteStream(this.path, { flags: "a" });
      this.stream.on("error", (err) => {
        console.warn(`[history-log ${this.sessionId}] stream error:`, err.message);
      });
    } catch (err) {
      console.warn(`[history-log ${this.sessionId}] open error:`, err.message);
      this.stream = null;
    }
  }

  write(data) {
    if (this._closed || !data || data.length === 0) return;
    const chunk = typeof data === "string" ? data : data.toString();
    const bytes = Buffer.byteLength(chunk, "utf-8");
    this.pending.push(chunk);
    this.pendingSize += bytes;

    if (this.pendingSize >= FLUSH_BYTE_THRESHOLD) {
      this._flushNow();
      return;
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this._flushNow(), FLUSH_INTERVAL_MS);
    if (!this.deadlineTimer) {
      this.deadlineTimer = setTimeout(() => this._flushNow(), FLUSH_DEADLINE_MS);
    }
  }

  _flushNow() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = null; }
    if (this.pending.length === 0) return;
    if (this._rotating) {
      // Pending stays — will flush after rotate completes.
      return;
    }

    this._openStream();
    if (!this.stream) {
      this.pending = [];
      this.pendingSize = 0;
      return;
    }

    const data = this.pending.join("");
    const bytes = Buffer.byteLength(data, "utf-8");
    this.pending = [];
    this.pendingSize = 0;

    try {
      this.stream.write(data);
      this._currentSize += bytes;
    } catch (err) {
      console.warn(`[history-log ${this.sessionId}] write error:`, err.message);
    }

    if (this._currentSize > MAX_FILE_SIZE && !this._rotating) {
      this._scheduleRotate();
    }
  }

  _scheduleRotate() {
    this._rotating = true;
    setImmediate(() => this._rotate());
  }

  async _rotate() {
    const tmpPath = this.path + ".tmp";
    try {
      if (this.stream) {
        await new Promise((resolve) => this.stream.end(() => resolve()));
        this.stream = null;
      }

      let stat;
      try { stat = fs.statSync(this.path); }
      catch { return; }

      let cutPos = Math.max(0, stat.size - ROTATE_KEEP);

      // Align to next newline within probe window. Avoids cutting mid-CSI.
      try {
        const fd = fs.openSync(this.path, "r");
        const probeEnd = Math.min(cutPos + ROTATE_PROBE_BYTES, stat.size);
        const probeLen = probeEnd - cutPos;
        if (probeLen > 0) {
          const probe = Buffer.alloc(probeLen);
          const read = fs.readSync(fd, probe, 0, probeLen, cutPos);
          for (let i = 0; i < read; i++) {
            if (probe[i] === 0x0a) {
              cutPos = cutPos + i + 1;
              break;
            }
          }
        }
        fs.closeSync(fd);
      } catch (err) {
        console.warn(`[history-log ${this.sessionId}] probe error:`, err.message);
      }

      await new Promise((resolve, reject) => {
        const reader = fs.createReadStream(this.path, { start: cutPos });
        const writer = fs.createWriteStream(tmpPath, { flags: "w" });
        reader.on("error", reject);
        writer.on("error", reject);
        writer.on("finish", resolve);
        reader.pipe(writer);
      });

      fs.renameSync(tmpPath, this.path);
      this._currentSize = fs.statSync(this.path).size;
    } catch (err) {
      console.warn(`[history-log ${this.sessionId}] rotate error:`, err.message);
      try { fs.unlinkSync(tmpPath); } catch {}
    } finally {
      this._rotating = false;
      this._openStream();
      if (this.pending.length > 0) {
        setImmediate(() => this._flushNow());
      }
    }
  }

  /** Synchronous best-effort flush + stream end. Returns Promise. */
  close() {
    this._closed = true;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = null; }
    if (this.pending.length > 0) {
      try {
        fs.appendFileSync(this.path, this.pending.join(""));
      } catch (err) {
        console.warn(`[history-log ${this.sessionId}] final flush error:`, err.message);
      }
      this.pending = [];
      this.pendingSize = 0;
    }
    if (this.stream) {
      const stream = this.stream;
      this.stream = null;
      return new Promise((resolve) => stream.end(() => resolve()));
    }
    return Promise.resolve();
  }

  /** Hard delete — discards pending writes, removes file + .tmp. */
  delete() {
    this._closed = true;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = null; }
    this.pending = [];
    this.pendingSize = 0;
    if (this.stream) {
      try { this.stream.destroy(); } catch {}
      this.stream = null;
    }
    try { fs.unlinkSync(this.path); } catch {}
    try { fs.unlinkSync(this.path + ".tmp"); } catch {}
  }
}

HistoryLog.BUFFERS_DIR = BUFFERS_DIR;
HistoryLog.MAX_FILE_SIZE = MAX_FILE_SIZE;

HistoryLog.getPath = function (sessionId) {
  return path.join(BUFFERS_DIR, `${sessionId}.log`);
};

HistoryLog.getSize = function (sessionId) {
  try { return fs.statSync(HistoryLog.getPath(sessionId)).size; }
  catch { return 0; }
};

/**
 * Synchronous tail read — returns last N bytes as utf-8 string. Used by
 * `_loadSessions` to seed in-memory buffer across PM2 restart so reconnect
 * still has a recent replay source. Returns "" on missing/empty.
 */
HistoryLog.tail = function (sessionId, bytes) {
  try {
    const filePath = HistoryLog.getPath(sessionId);
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return "";
    const start = Math.max(0, stat.size - bytes);
    const len = stat.size - start;
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString("utf-8");
  } catch {
    return "";
  }
};

module.exports = { HistoryLog };
