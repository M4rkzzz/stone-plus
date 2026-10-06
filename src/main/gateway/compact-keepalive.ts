import type { ServerResponse } from 'node:http'

/** Transport-only beats while compact output is buffered for validation. */
export class CompactSseKeepalive {
  private timer?: ReturnType<typeof setInterval>
  private drainTimer?: ReturnType<typeof setTimeout>
  private pendingDrain = false
  committed = false

  constructor(
    private readonly response: ServerResponse,
    private readonly intervalMs: number,
    private readonly onFailure: () => void,
  ) {}

  // Once account-bound continuation headers were sent, changing sources would
  // pair the new compact item with the old source's state. Fail closed instead.
  get locksSource(): boolean {
    return this.committed && Boolean(this.response.getHeader('x-codex-turn-state'))
  }

  start(beforeCommit: () => void): void {
    this.stop()
    if (this.intervalMs <= 0) return
    this.timer = setInterval(() => {
      if (this.response.destroyed || this.response.writableEnded) return this.stop()
      if (this.pendingDrain) return
      try {
        if (!this.response.headersSent) {
          beforeCommit()
          this.response.statusCode = 200
          this.response.setHeader('content-type', 'text/event-stream; charset=utf-8')
          this.response.setHeader('cache-control', 'no-cache')
          this.response.setHeader('x-accel-buffering', 'no')
        }
        this.committed = true
        if (!this.response.write(': keepalive\n\n')) {
          this.pendingDrain = true
          this.response.once('drain', this.onDrain)
          this.drainTimer = setTimeout(() => this.fail(), 10_000)
          this.drainTimer.unref()
        }
      } catch {
        this.fail()
      }
    }, this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.timer = undefined
    this.drainTimer = undefined
    this.response.off('drain', this.onDrain)
    this.pendingDrain = false
  }

  private readonly onDrain = (): void => {
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = undefined
    this.pendingDrain = false
  }

  private fail(): void {
    this.stop()
    this.onFailure()
    this.response.destroy()
  }
}
