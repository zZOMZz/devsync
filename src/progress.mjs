import { clearLine, cursorTo } from "node:readline";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const units = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
export function curlSize(value) {
  const match = /^(\d+(?:\.\d+)?)([kmgt])?$/i.exec(value);
  return match
    ? Number(match[1]) * (units[match[2]?.toLowerCase()] || 1)
    : null;
}
export function parseCurlProgress(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 12 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[2]))
    return null;
  const total = curlSize(parts[1]),
    received = curlSize(parts[3]);
  if (total === null || received === null) return null;
  return {
    total,
    received,
    percent: Math.min(100, Number(parts[2])),
    speed: curlSize(parts[11]) ?? curlSize(parts[6]),
    remaining: parts[10],
  };
}
const size = (bytes) =>
  bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;

export class Progress {
  constructor(
    label,
    { stream = process.stderr, now = Date.now, tickMs = 100, interactive = Boolean(stream.isTTY) && process.env.TERM !== "dumb", successSymbol = "✓", failureSymbol = "✗" } = {},
  ) {
    this.label = label;
    this.stream = stream;
    this.interactive = interactive;
    this.successSymbol = successSymbol;
    this.failureSymbol = failureSymbol;
    this.now = now;
    this.started = this.lastChange = now();
    this.lastPrint = -Infinity;
    this.frame = 0;
    this.buffer = "";
    this.finished = false;
    this.render();
    this.timer = setInterval(() => this.render(), tickMs);
    this.timer.unref();
  }
  consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/[\r\n]/);
    this.buffer = lines.pop().slice(-4096);
    for (const line of lines) {
      const next = parseCurlProgress(line);
      if (!next) continue;
      if (next.received !== this.data?.received) this.lastChange = this.now();
      this.data = next;
    }
  }
  text() {
    const elapsed = Math.floor((this.now() - this.started) / 1000);
    const d = this.data;
    if (!d?.received) return `${this.label}… 已等待 ${elapsed} 秒`;
    let detail = `${size(d.received)}`;
    if (d.total > 0) {
      const fill = Math.round((d.percent / 100) * 16);
      detail = `[${"=".repeat(fill)}${"-".repeat(16 - fill)}] ${d.percent}% · ${detail} / ${size(d.total)}`;
    }
    if (d.speed > 0) detail += ` · ${size(d.speed)}/s`;
    const stalled = Math.floor((this.now() - this.lastChange) / 1000);
    if (stalled >= 10) detail += ` · 已 ${stalled} 秒未收到新数据，正在等待`;
    else if (d.total > 0 && /^\d+:\d+:\d+$/.test(d.remaining))
      detail += ` · 预计剩余 ${d.remaining}`;
    return `${this.label} · ${detail}`;
  }
  render() {
    if (this.finished) return;
    const now = this.now();
    if (!this.interactive && now - this.lastPrint < 5000) return;
    const text = `${this.interactive ? frames[this.frame++ % frames.length] : "…"} ${this.text()}`;
    if (this.interactive) {
      cursorTo(this.stream, 0);
      clearLine(this.stream, 0);
      // Keep output on one line even in narrow terminal windows.
      const max = Math.max(10, (this.stream.columns || 100) - 2);
      let width = 0,
        visible = "";
      for (const c of text) {
        const n = c.codePointAt(0) > 255 ? 2 : 1;
        if (width + n > max - 1) {
          visible += "…";
          break;
        }
        visible += c;
        width += n;
      }
      this.stream.write(visible);
    } else this.stream.write(text + "\n");
    this.lastPrint = now;
  }
  stop(success) {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.timer);
    if (this.interactive) {
      cursorTo(this.stream, 0);
      clearLine(this.stream, 0);
    }
    this.stream.write(
      `${success ? this.successSymbol : this.failureSymbol} ${this.label}${success ? "完成" : "失败"}（${((this.now() - this.started) / 1000).toFixed(1)} 秒）\n`,
    );
  }
}
export async function withProgress(label, task, options) {
  const progress = new Progress(label, options);
  try {
    const result = await task(progress);
    progress.stop(true);
    return result;
  } catch (error) {
    progress.stop(false);
    throw error;
  }
}
