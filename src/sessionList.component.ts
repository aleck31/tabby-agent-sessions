import { execFile } from 'child_process'
import { accessSync, constants } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Component, ElementRef, Injector } from '@angular/core'
import {
  BaseTabComponent,
  NotificationsService,
  PlatformService,
  SplitContainer,
  SplitTabComponent,
} from 'tabby-core'

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

/** Single source for the default; index.ts feeds it to the ConfigProvider. */
export const DEFAULT_PANE_WIDTH_PX = 360

/**
 * Keyed on asbutler's `agent` string. Absent agent = no resume, rather than a guessed
 * command that would launch the wrong thing; asbutler itself has no resume subcommand.
 */
const RESUME_ARGV: Record<string, (id: string) => string[]> = {
  'Claude Code': id => ['claude', '--resume', id],
  Kiro: id => ['kiro-cli', 'chat', '--resume-id', id],
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
 * asbutler owns session parsing; `--path` must narrow before it enriches. ADR-0002 D1/D2.
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

interface RemoveResult {
  id: string
  deleted: boolean
  error?: string
}

/**
 * `rm` exits non-zero on failure but still prints the reason as JSON, so stdout is
 * parsed regardless of the exit code — the exec error alone loses the actual cause.
 */
function runAsbutlerRm(bin: string, id: string): Promise<RemoveResult[]> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['rm', id], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(err ?? new Error('asbutler rm returned non-JSON output'))
      }
    })
  })
}

@Component({
  selector: 'agent-session-list',
  template: `
    <!-- Classes stay as-prefixed: Tabby's global Bootstrap matches bare names like .row. -->
    <div class="as-panel">
      <div class="as-head">
        <strong>Agent Sessions</strong>
        <button class="btn btn-link btn-sm" (click)="refresh()" [disabled]="loading">
          {{ loading ? '…' : '↻' }}
        </button>
      </div>
      <div class="as-cwd" [title]="cwd || ''">{{ cwd || 'no local directory' }}</div>
      <div class="as-err" *ngIf="error">{{ error }}</div>
      <!-- No cwd and no sessions are different answers; say which one this is. -->
      <div class="as-empty" *ngIf="!error && !loading && sessions.length === 0">
        {{ emptyMessage }}
      </div>
      <div class="as-row" *ngFor="let s of sessions"
           [class.as-selected]="s.id === selectedId"
           [title]="rowHint(s)"
           (click)="selectedId = s.id"
           (dblclick)="resume(s)">
        <div class="as-line1">
          <span class="as-when">{{ s.modifiedAt | date: 'MM-dd HH:mm' }}</span>
          <span class="as-id">{{ s.id.slice(0, 8) }}</span>
          <span class="as-lock" *ngIf="s.locked" title="held by a running agent">🔒</span>
          <span class="as-size">{{ s.sizeHuman }}</span>
        </div>
        <!-- Own tooltip: the title is ellipsised, so hovering it must still reveal the full text. -->
        <div class="as-title" [title]="s.title">{{ s.title || '(untitled)' }}</div>
        <div class="as-meta">{{ s.agent }} · {{ s.messageCount }} msgs</div>
        <!-- stopPropagation first: without it these also hit the row's select/resume handlers. -->
        <span class="as-actions">
          <button class="as-act" *ngIf="isResumable(s)" title="Resume this session"
                  (click)="$event.stopPropagation(); resume(s)">▶</button>
          <button class="as-act as-danger" title="Delete this session permanently"
                  (click)="$event.stopPropagation(); remove(s)">✕</button>
        </span>
      </div>
    </div>
  `,
  styles: [`
    /* Neutral translucent tint: lifts off a dark terminal, darkens against a light one. */
    /* No divider of our own: Tabby's split-tab-spanner already draws one on the boundary. */
    :host { display: block; height: 100%; background: rgba(127, 127, 127, .09); }
    .as-panel { height: 100%; box-sizing: border-box; overflow-y: auto; overflow-x: hidden;
                padding: 8px; font-size: 12px; }
    .as-head { display: flex; justify-content: space-between; align-items: center; }
    .as-cwd { opacity: .6; word-break: break-all; margin: 4px 0 8px; font-family: monospace; }
    .as-err { color: #e57373; margin-bottom: 8px; }
    .as-empty { opacity: .5; font-style: italic; }
    .as-row { position: relative; padding: 6px 4px; margin: 0;
              border-top: 1px solid rgba(255,255,255,.08); border-radius: 3px; }
    .as-row:hover { background: rgba(127, 127, 127, .12); }
    .as-row.as-selected { background: rgba(127, 127, 127, .22);
                          box-shadow: inset 2px 0 0 rgba(140, 180, 255, .9); }
    /* Absolute, not display:none->flex — in flow they resize the row on hover and it flickers. */
    .as-actions { position: absolute; bottom: 5px; right: 4px; display: flex; gap: 6px;
                  opacity: 0; pointer-events: none; }
    .as-row:hover .as-actions { opacity: 1; pointer-events: auto; }
    .as-act { background: none; border: 0; padding: 0 3px; color: inherit;
              opacity: .55; cursor: pointer; font-size: 12px; line-height: 1; }
    .as-act:hover { opacity: 1; }
    .as-act.as-danger:hover { color: #e57373; }
    .as-line1 { display: flex; gap: 6px; align-items: center; }
    .as-when { font-weight: 600; font-variant-numeric: tabular-nums; }
    .as-id { opacity: .45; font-family: monospace; }
    .as-size { margin-left: auto; opacity: .6; }
    .as-title { margin: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .as-meta { opacity: .5; }
  `],
})
export class SessionListTabComponent extends BaseTabComponent {
  cwd: string | null = null
  sessions: AgentSession[] = []
  selectedId: string | null = null
  error: string | null = null
  loading = false

  private pollTimer: any
  /** Discards responses from a query the cwd has already moved past. */
  private generation = 0
  /** The width to hold, in px; the ratio Tabby wants is recomputed from it. ADR-0001 D2. */
  private pinnedPx: number = this.config.store.agentSessions?.width ?? DEFAULT_PANE_WIDTH_PX
  private onWindowResize = () => this.holdWidth()

  constructor(
    injector: Injector,
    private el: ElementRef,
    private notifications: NotificationsService,
    private platform: PlatformService,
  ) {
    super(injector)
    this.setTitle('Agent Sessions')
  }

  isResumable(s: AgentSession): boolean {
    return !s.locked && !!this.resumeCommand(s)
  }

  rowHint(s: AgentSession): string {
    if (s.locked) {
      return 'A running agent holds this session — resuming would give it a second writer'
    }
    const command = this.resumeCommand(s)
    return command
      ? `Double-click to run in the terminal beside this list:\n${command}`
      : `No resume command known for ${s.agent}`
  }

  /** Permanent: asbutler unlinks the file, and the JSON exposes no path for us to trash instead. */
  async remove(s: AgentSession): Promise<void> {
    if (s.locked) {
      this.notifications.error('A running agent holds this session — stop it before deleting')
      return
    }

    const { response } = await this.platform.showMessageBox({
      type: 'warning',
      message: 'Delete this session permanently?',
      detail: [
        `${s.agent} · ${s.messageCount} msgs · ${s.sizeHuman}`,
        s.title || s.id,
        '',
        'This cannot be undone.',
      ].join('\n'),
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response !== 1) {
      return
    }

    try {
      const bin = resolveBinary(this.bin)
      if (!bin) {
        throw new Error(`'${this.bin}' not found`)
      }
      const failed = (await runAsbutlerRm(bin, s.id)).find(r => !r.deleted)
      if (failed) {
        throw new Error(failed.error ?? 'asbutler reported the session was not deleted')
      }
      if (this.selectedId === s.id) {
        this.selectedId = null
      }
      this.sessions = this.sessions.filter(x => x.id !== s.id)
    } catch (e: any) {
      this.notifications.error(`Delete failed: ${e.message ?? String(e)}`)
    }
  }

  /** Types into the adjacent terminal, never spawns — ADR-0001 D7. */
  async resume(s: AgentSession): Promise<void> {
    const command = this.resumeCommand(s)
    if (s.locked || !command) {
      this.notifications.error(this.rowHint(s))
      return
    }

    const tab = this.focusedSibling()
    const session = tab?.session
    if (!session) {
      this.notifications.error('No local terminal beside this list to run it in')
      return
    }

    // Never queue input behind a running command — it would fire later, whenever that finishes.
    const busy = await session.getChildProcesses?.().catch(() => []) ?? []
    if (busy.length) {
      this.notifications.error(`${busy[0].command ?? 'A command'} is still running in that terminal`)
      return
    }

    if (tab.sendInput) {
      tab.sendInput(command + '\n')
    } else {
      session.write(Buffer.from(command + '\n'))
    }
  }

  /** The id reaches a live shell as text, so reject anything that isn't inert before joining. */
  private resumeCommand(s: AgentSession): string | null {
    const build = RESUME_ARGV[s.agent]
    if (!build || !/^[A-Za-z0-9._-]+$/.test(s.id)) {
      return null
    }
    return build(s.id).join(' ')
  }

  private get bin(): string {
    return this.config.store.agentSessions?.binary || 'asbutler'
  }

  /** Kept out of the template: prose with apostrophes needs double escaping through the TS literal. */
  get emptyMessage(): string {
    return this.cwd
      ? 'No sessions for this directory'
      : "This tab has no local directory — remote shells aren't grouped by cwd"
  }

  ngOnInit(): void {
    // Follow whichever pane has focus, so the list tracks the terminal you're looking at.
    const parent = this.parent
    if (parent instanceof SplitTabComponent) {
      this.subscribeUntilDestroyed(parent.focusChanged$, () => this.syncCwd())
      // A drag re-pins to the width it settled on, rather than reverting to proportional.
      this.subscribeUntilDestroyed(parent.splitAdjusted$, () => this.adoptWidth())
    }
    // Window resize only — a ResizeObserver here broke dragging. ADR-0001 D2.
    window.addEventListener('resize', this.onWindowResize)
    this.holdWidth()
    this.syncCwd()
    this.pollTimer = setInterval(() => this.syncCwd(), 2000)
  }

  ngOnDestroy(): void {
    clearInterval(this.pollTimer)
    window.removeEventListener('resize', this.onWindowResize)
    super.ngOnDestroy()
  }

  /** Re-derives the ratio so the pinned px width holds through a container resize. */
  private holdWidth(attempt = 0): void {
    const parent = this.parent
    if (!(parent instanceof SplitTabComponent)) {
      return
    }
    // Mid-drag the user owns the width; correcting it here would fight the spanner.
    if ((parent as any)._spannerResizing) {
      return
    }
    const container: SplitContainer | null = parent.getParentOf(this as any)
    const index = container?.children.indexOf(this as any) ?? -1
    if (!container || index < 0 || container.ratios.length < 2) {
      return
    }
    // On first insert the split area has no width yet; it lands a frame later.
    const containerPx = this.containerPx(container)
    if (!containerPx) {
      if (attempt < 10) {
        requestAnimationFrame(() => this.holdWidth(attempt + 1))
      }
      return
    }

    // A width configured as <= 1 is a legacy fraction; convert it to px once, then pin that.
    if (this.pinnedPx <= 1) {
      this.pinnedPx *= containerPx
    }

    // Already correct — skip: layout() rebuilds _spanners and their drag listeners.
    if (Math.abs(container.ratios[index] * containerPx - this.pinnedPx) <= 1) {
      return
    }

    const share = Math.min(Math.max(this.pinnedPx / containerPx, 0.05), 0.9)
    const rest = container.ratios.reduce((sum, r, i) => i === index ? sum : sum + r, 0)
    const siblings = container.ratios.length - 1
    container.ratios = container.ratios.map((r, i) =>
      i === index
        ? share
        : rest > 0 ? r / rest * (1 - share) : (1 - share) / siblings,
    )
    parent.layout()
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
    // A selection belongs to the directory it was made in; a plain refresh keeps it.
    this.selectedId = null
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
      // Parse, don't string-compare: modifiedAt carries a numeric offset, so lexical order breaks across offsets.
      this.sessions = sessions.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
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

  /** The focused sibling first, else any sibling — never this pane itself. */
  private siblingCandidates(): any[] {
    const parent = this.parent
    if (!(parent instanceof SplitTabComponent)) {
      return []
    }
    const focused = parent.getFocusedTab()
    return focused && focused !== (this as any)
      ? [focused]
      : parent.getAllTabs().filter(t => t !== (this as any))
  }

  /** The local terminal this list is tracking, and where a resume gets typed. */
  private focusedSibling(): any {
    return this.siblingCandidates()
      .find(t => t.session?.supportsWorkingDirectory?.()) ?? null
  }

  /**
   * Measures the split area, never the pane: panes carry a 0.125s width transition.
   * `container.w` is a percentage of that area, not px. See ADR-0001 D2.
   */
  private containerPx(container: SplitContainer): number {
    const areaPx = (this.el.nativeElement as HTMLElement).parentElement?.clientWidth ?? 0
    return areaPx * (container.w || 100) / 100
  }

  /** Take the width the drag settled on, read from the ratios rather than the animating DOM. */
  private adoptWidth(): void {
    const parent = this.parent
    if (!(parent instanceof SplitTabComponent)) {
      return
    }
    const container: SplitContainer | null = parent.getParentOf(this as any)
    const index = container?.children.indexOf(this as any) ?? -1
    if (!container || index < 0) {
      return
    }
    const px = container.ratios[index] * this.containerPx(container)
    if (px > 0) {
      this.pinnedPx = px
    }
  }

  /** cwd of the focused sibling pane; null for SSH/serial tabs, which have no local cwd. */
  private async focusedCwd(): Promise<string | null> {
    for (const tab of this.siblingCandidates()) {
      const session = tab.session
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
