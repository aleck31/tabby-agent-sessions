import { execFile } from 'child_process'
import { accessSync, constants } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Component, Injector } from '@angular/core'
import { BaseTabComponent, SplitTabComponent } from 'tabby-core'

/** GUI apps inherit a minimal PATH from launchd, so resolve the binary ourselves. */
const SEARCH_DIRS = [
  join(homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
]

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveBinary(configured: string): string | null {
  const expanded = configured.startsWith('~')
    ? join(homedir(), configured.slice(1))
    : configured
  if (expanded.includes('/')) {
    return isExecutable(expanded) ? expanded : null
  }
  const dirs = [...SEARCH_DIRS, ...(process.env.PATH ?? '').split(':').filter(Boolean)]
  for (const dir of dirs) {
    const candidate = join(dir, expanded)
    if (isExecutable(candidate)) {
      return candidate
    }
  }
  return null
}

export interface AgentSession {
  id: string
  agent: string
  cwd: string
  profile: string
  orphan: boolean
  title: string
  messageCount: number
  fileSize: number
  sizeHuman: string
  modifiedAt: string
  locked: boolean
}

/**
 * Single source of truth is the asbutler binary — don't reimplement session
 * parsing here. `--path` narrows before asbutler enriches, which is the whole
 * cost of the call, so never fetch machine-wide and filter on this side.
 */
function runAsbutler(bin: string, cwd: string): Promise<AgentSession[]> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['list', '--path', cwd], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err)
        return
      }
      try {
        resolve(JSON.parse(stdout).sessions ?? [])
      } catch {
        reject(new Error('asbutler returned non-JSON output — needs asbutler >= 0.6.1'))
      }
    })
  })
}

@Component({
  selector: 'agent-session-list',
  template: `
    <div class="panel">
      <div class="head">
        <strong>Agent Sessions</strong>
        <button class="btn btn-link btn-sm" (click)="refresh()" [disabled]="loading">
          {{ loading ? '…' : '↻' }}
        </button>
      </div>
      <div class="cwd" [title]="cwd || ''">{{ cwd || 'no working directory' }}</div>
      <div class="err" *ngIf="error">{{ error }}</div>
      <div class="empty" *ngIf="!error && !loading && sessions.length === 0">
        No sessions for this directory
      </div>
      <div class="row" *ngFor="let s of sessions">
        <div class="line1">
          <span class="agent">{{ s.agent }}</span>
          <span class="lock" *ngIf="s.locked" title="held by a running agent">🔒</span>
          <span class="size">{{ s.sizeHuman }}</span>
        </div>
        <div class="title" [title]="s.title">{{ s.title || s.id }}</div>
        <div class="meta">{{ s.messageCount }} msgs · {{ s.modifiedAt | date: 'MM-dd HH:mm' }}</div>
      </div>
    </div>
  `,
  styles: [`
    /* Neutral translucent tint: lifts off a dark terminal, darkens against a light one. */
    :host { display: block; height: 100%; background: rgba(127, 127, 127, .09); }
    .panel { height: 100%; overflow-y: auto; padding: 8px; font-size: 12px;
             box-shadow: inset -1px 0 0 rgba(127, 127, 127, .22); }
    .head { display: flex; justify-content: space-between; align-items: center; }
    .cwd { opacity: .6; word-break: break-all; margin: 4px 0 8px; font-family: monospace; }
    .err { color: #e57373; margin-bottom: 8px; }
    .empty { opacity: .5; font-style: italic; }
    .row { padding: 6px 0; border-top: 1px solid rgba(255,255,255,.08); }
    .line1 { display: flex; gap: 6px; align-items: center; }
    .agent { font-weight: 600; }
    .size { margin-left: auto; opacity: .6; }
    .title { margin: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { opacity: .5; }
  `],
})
export class SessionListTabComponent extends BaseTabComponent {
  cwd: string | null = null
  sessions: AgentSession[] = []
  error: string | null = null
  loading = false

  private pollTimer: any
  /** Discards responses from a query the cwd has already moved past. */
  private generation = 0

  constructor(injector: Injector) {
    super(injector)
    this.setTitle('Agent Sessions')
  }

  private get bin(): string {
    return this.config.store.agentSessions?.binary || 'asbutler'
  }

  ngOnInit(): void {
    // Follow whichever pane has focus, so the list tracks the terminal you're looking at.
    const parent = this.parent
    if (parent instanceof SplitTabComponent) {
      this.subscribeUntilDestroyed(parent.focusChanged$, () => this.syncCwd())
    }
    this.syncCwd()
    this.pollTimer = setInterval(() => this.syncCwd(), 2000)
  }

  ngOnDestroy(): void {
    clearInterval(this.pollTimer)
    super.ngOnDestroy()
  }

  refresh(): void {
    this.load(this.cwd)
  }

  /** Only re-queries when the directory actually changed — each call costs a scan. */
  private async syncCwd(): Promise<void> {
    const next = await this.focusedCwd()
    if (next === this.cwd) {
      return
    }
    this.cwd = next
    this.load(next)
  }

  private async load(cwd: string | null): Promise<void> {
    const generation = ++this.generation
    this.error = null
    if (!cwd) {
      this.sessions = []
      this.loading = false
      return
    }

    this.loading = true
    try {
      const bin = resolveBinary(this.bin)
      if (!bin) {
        throw new Error(
          `'${this.bin}' not found in ${SEARCH_DIRS.join(', ')} or $PATH — ` +
          `set agentSessions.binary in config.yaml`,
        )
      }
      const sessions = await runAsbutler(bin, cwd)
      if (generation !== this.generation) {
        return
      }
      this.sessions = sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    } catch (e: any) {
      if (generation !== this.generation) {
        return
      }
      this.error = e.message ?? String(e)
      this.sessions = []
    } finally {
      if (generation === this.generation) {
        this.loading = false
      }
    }
  }

  /** cwd of the focused sibling pane; null for SSH/serial tabs, which have no local cwd. */
  private async focusedCwd(): Promise<string | null> {
    const parent = this.parent
    if (!(parent instanceof SplitTabComponent)) {
      return null
    }
    const focused = parent.getFocusedTab()
    const candidates = focused && focused !== (this as any)
      ? [focused]
      : parent.getAllTabs().filter(t => t !== (this as any))
    for (const tab of candidates) {
      const session = (tab as any).session
      if (session?.supportsWorkingDirectory?.()) {
        const cwd = await session.getWorkingDirectory()
        if (cwd) {
          return cwd
        }
      }
    }
    return null
  }
}
