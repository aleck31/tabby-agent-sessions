import { Component, ElementRef, Injector } from '@angular/core'
import {
  BaseTabComponent,
  NotificationsService,
  PlatformService,
  SplitTabComponent,
} from 'tabby-core'

import {
  AgentSession,
  Runner,
  SEARCH_DIRS,
  humanSize,
  listSessions,
  localRunner,
  remoteRunner,
  removeSessions as asbutlerRemove,
  resolveBinary,
} from './asbutler'
import { PaneWidth } from './paneWidth'

/** Injected by webpack's DefinePlugin; tells you which bundle Tabby actually loaded. */
declare const __PLUGIN_BUILD__: string

/**
 * Keyed on asbutler's `agent` string. Absent agent = no resume, rather than a guessed
 * command that would launch the wrong thing; asbutler itself has no resume subcommand.
 */
const RESUME_ARGV: Record<string, (id: string) => string[]> = {
  'Claude Code': id => ['claude', '--resume', id],
  Kiro: id => ['kiro-cli', 'chat', '--resume-id', id],
}

@Component({
  selector: 'agent-session-list',
  template: `
    <!-- Classes stay as-prefixed: Tabby's global Bootstrap matches bare names like .row. -->
    <div class="as-panel">
      <div class="as-head">
        <strong>Agent Sessions</strong>
        <!-- Names the host when remote, so a wrong target or silent failure stays visible. -->
        <span class="as-where" *ngIf="transport">{{ transport }}</span>
        <button class="btn btn-link btn-sm" (click)="refresh()" [disabled]="loading"
                [title]="(loading ? 'Loading…' : 'Refresh') + ' · build ' + build">
          <span class="as-spin" *ngIf="loading"></span>
          <span *ngIf="!loading">↻</span>
        </button>
      </div>
      <div class="as-cwd" [title]="cwd || ''">{{ cwd || 'no working directory' }}</div>
      <div class="as-err" *ngIf="error">{{ error }}</div>
      <div class="as-hint" *ngIf="error?.includes('not installed')">
        Get it from
        <a class="as-link" href="https://github.com/aleck31/agent-session-butler/releases"
           (click)="openReleases($event)">the asbutler releases page</a>
      </div>
      <!-- Outside as-body, or the stale dimming makes these near-invisible on a first load. -->
      <div class="as-empty" *ngIf="loading && sessions.length === 0">Querying asbutler…</div>
      <div class="as-empty" *ngIf="!error && !loading && visible.length === 0">
        {{ emptyMessage }}
      </div>

      <!-- Dimmed and inert while these rows belong to a directory we have already left. -->
      <div class="as-body" [class.as-stale]="stale">
      <!-- Filters the rows already fetched; re-querying with -a would cost another subprocess. -->
      <div class="as-chips" *ngIf="agentCounts.length > 1">
        <button class="as-chip" [class.as-chip-on]="agentFilter === null"
                (click)="setAgentFilter(null)">All {{ sessions.length }}</button>
        <button class="as-chip" *ngFor="let a of agentCounts"
                [class.as-chip-on]="agentFilter === a.agent"
                (click)="setAgentFilter(a.agent)">{{ a.agent }} {{ a.count }}</button>
      </div>

      <div class="as-bulk" *ngIf="selectedIds.size > 1">
        <span>{{ selectedIds.size }} selected</span>
        <button class="as-act" (click)="clearSelection()">Clear</button>
        <button class="as-act as-danger" (click)="removeSelected()">Delete</button>
      </div>

      <div class="as-row" *ngFor="let s of visible"
           [class.as-selected]="selectedIds.has(s.id)"
           [title]="rowHint(s)"
           (click)="onRowClick(s, $event)"
           (dblclick)="resume(s)">
        <div class="as-line1">
          <span class="as-when">{{ s.modifiedAt | date: 'MM-dd HH:mm' }}</span>
          <span class="as-id">{{ s.id.slice(0, 8) }}</span>
          <span class="as-orphan" *ngIf="s.orphan"
                title="This session's directory no longer exists">orphan</span>
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
    </div>
  `,
  styles: [`
    /* Neutral translucent tint: lifts off a dark terminal, darkens against a light one. */
    /* No divider of our own: Tabby's split-tab-spanner already draws one on the boundary. */
    :host { display: block; height: 100%; background: rgba(127, 127, 127, .09); }
    .as-panel { height: 100%; box-sizing: border-box; overflow-y: auto; overflow-x: hidden;
                padding: 8px; font-size: 12px; }
    .as-head { display: flex; justify-content: space-between; align-items: center; }
    .as-where { opacity: .45; margin-right: auto; margin-left: 6px; }
    .as-cwd { opacity: .6; word-break: break-all; margin: 4px 0 8px; font-family: monospace; }
    .as-err { color: #e57373; margin-bottom: 4px; white-space: pre-wrap; }
    .as-hint { opacity: .7; margin-bottom: 8px; }
    .as-link { color: #8cb4ff; text-decoration: underline; cursor: pointer; }
    .as-empty { opacity: .5; font-style: italic; }
    /* Inert as well as dim: acting on a stale row would hit the directory we just left. */
    .as-stale { opacity: .4; pointer-events: none; }
    .as-spin { display: inline-block; width: 9px; height: 9px; vertical-align: -1px;
               border: 2px solid currentColor; border-right-color: transparent;
               border-radius: 50%; animation: as-rot .7s linear infinite; }
    @keyframes as-rot { to { transform: rotate(360deg); } }
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
    .as-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
    .as-chip { background: rgba(127, 127, 127, .15); border: 0; border-radius: 9px;
               padding: 2px 8px; color: inherit; opacity: .7; cursor: pointer; font-size: 11px; }
    .as-chip:hover { opacity: 1; }
    .as-chip.as-chip-on { background: rgba(140, 180, 255, .3); opacity: 1; }
    .as-bulk { display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
               padding: 4px 6px; border-radius: 3px; background: rgba(140, 180, 255, .16); }
    .as-line1 { display: flex; gap: 6px; align-items: center; }
    .as-when { font-weight: 600; font-variant-numeric: tabular-nums; }
    .as-id { opacity: .45; font-family: monospace; }
    /* Amber, not red: an orphan is stale, not broken, and red is the delete affordance. */
    .as-orphan { color: #e0a33e; border: 1px solid rgba(224, 163, 62, .5);
                 border-radius: 3px; padding: 0 3px; font-size: 10px; }
    .as-size { margin-left: auto; opacity: .6; }
    .as-title { margin: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .as-meta { opacity: .5; }
  `],
})
export class SessionListTabComponent extends BaseTabComponent {
  cwd: string | null = null
  sessions: AgentSession[] = []
  /** Rows after the agent filter; kept as a field so the template isn't rebuilding arrays. */
  visible: AgentSession[] = []
  agentCounts: { agent: string, count: number }[] = []
  agentFilter: string | null = null
  /** Which machine asbutler ran on, shown so a wrong host or a hang is never silent. */
  transport: string | null = null
  readonly build = __PLUGIN_BUILD__
  selectedIds = new Set<string>()
  error: string | null = null
  loading = false

  /** The directory `sessions` was fetched for, so staleness is a fact rather than a guess. */
  private sessionsCwd: string | null = null
  /** Anchor for shift-click ranges. */
  private anchorId: string | null = null
  private pollTimer: any
  /** Discards responses from a query the cwd has already moved past. */
  private generation = 0
  /** Pixel width inside Tabby's fractional split model; all of it lives in PaneWidth. */
  private width = new PaneWidth(
    this,
    this.el.nativeElement,
    this.config.store.agentSessions?.width,
  )

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

  /** Rows on screen belong to a directory we have already left, so they must not be acted on. */
  get stale(): boolean {
    return this.cwd !== this.sessionsCwd
  }

  /** Plain click replaces the selection; cmd/ctrl toggles one; shift extends from the anchor. */
  onRowClick(s: AgentSession, event: MouseEvent): void {
    if (event.shiftKey && this.anchorId) {
      const from = this.visible.findIndex(x => x.id === this.anchorId)
      const to = this.visible.findIndex(x => x.id === s.id)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        this.selectedIds = new Set(this.visible.slice(lo, hi + 1).map(x => x.id))
        return
      }
    }
    if (event.metaKey || event.ctrlKey) {
      this.selectedIds.has(s.id) ? this.selectedIds.delete(s.id) : this.selectedIds.add(s.id)
    } else {
      this.selectedIds = new Set([s.id])
    }
    this.anchorId = s.id
  }

  clearSelection(): void {
    this.selectedIds = new Set()
    this.anchorId = null
  }

  setAgentFilter(agent: string | null): void {
    this.agentFilter = agent
    // Clear first: a selection kept across a filter change would let Delete hit hidden rows.
    this.clearSelection()
    this.applyFilter()
  }

  /** Recomputed on data or filter change, so the template reads a stable array. */
  private applyFilter(): void {
    this.visible = this.agentFilter
      ? this.sessions.filter(s => s.agent === this.agentFilter)
      : this.sessions
    const counts = new Map<string, number>()
    for (const s of this.sessions) {
      counts.set(s.agent, (counts.get(s.agent) ?? 0) + 1)
    }
    this.agentCounts = [...counts].map(([agent, count]) => ({ agent, count }))
    // A filter whose agent no longer has rows would hide everything with no way back.
    if (this.agentFilter && !counts.has(this.agentFilter)) {
      this.agentFilter = null
      this.visible = this.sessions
    }
  }

  remove(s: AgentSession): Promise<void> {
    return this.removeSessions([s])
  }

  removeSelected(): Promise<void> {
    return this.removeSessions(this.sessions.filter(s => this.selectedIds.has(s.id)))
  }

  /** Permanent: asbutler unlinks the file, and the JSON exposes no path for us to trash instead. */
  private async removeSessions(targets: AgentSession[]): Promise<void> {
    // Locked sessions are skipped rather than failing the batch — a live agent holds them.
    const locked = targets.filter(s => s.locked)
    const doomed = targets.filter(s => !s.locked)
    if (!doomed.length) {
      this.notifications.error('A running agent holds these sessions — stop it before deleting')
      return
    }

    const { response } = await this.platform.showMessageBox({
      type: 'warning',
      message: doomed.length === 1
        ? 'Delete this session permanently?'
        : `Delete ${doomed.length} sessions permanently?`,
      detail: this.removalDetail(doomed, locked),
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response !== 1) {
      return
    }

    try {
      // Same transport as the listing, or a remote row's delete would run here instead.
      const runner = this.runnerFor(this.focusedSibling()?.session)
      const results = await asbutlerRemove(runner, doomed.map(s => s.id))
      const gone = new Set(results.filter(r => r.deleted).map(r => r.id))
      this.sessions = this.sessions.filter(s => !gone.has(s.id))
      gone.forEach(id => this.selectedIds.delete(id))
      this.applyFilter()

      const failed = results.filter(r => !r.deleted)
      if (failed.length) {
        throw new Error(failed[0].error ?? 'asbutler reported the session was not deleted')
      }
    } catch (e: any) {
      this.notifications.error(`Delete failed: ${e.message ?? String(e)}`)
    }
  }

  private removalDetail(doomed: AgentSession[], locked: AgentSession[]): string {
    const lines = doomed.length === 1
      ? [`${doomed[0].agent} · ${doomed[0].messageCount} msgs · ${doomed[0].sizeHuman}`,
         doomed[0].title || doomed[0].id]
      : [`${doomed.reduce((n, s) => n + s.messageCount, 0)} messages, ` +
         `${humanSize(doomed.reduce((n, s) => n + s.fileSize, 0))} total`,
         ...doomed.slice(0, 6).map(s => `· ${s.id.slice(0, 8)}  ${s.title || '(untitled)'}`),
         ...(doomed.length > 6 ? [`· …and ${doomed.length - 6} more`] : [])]
    if (locked.length) {
      lines.push('', `${locked.length} held by a running agent will be skipped.`)
    }
    return [...lines, '', 'This cannot be undone.'].join('\n')
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
  /** preventDefault, or Electron navigates the app window away from Tabby itself. */
  openReleases(event: Event): void {
    event.preventDefault()
    this.platform.openExternal('https://github.com/aleck31/agent-session-butler/releases')
  }

  get emptyMessage(): string {
    return this.cwd
      ? 'No sessions for this directory'
      : 'This terminal reports no working directory'
  }

  ngOnInit(): void {
    // Follow whichever pane has focus, so the list tracks the terminal you're looking at.
    const parent = this.parent
    if (parent instanceof SplitTabComponent) {
      this.subscribeUntilDestroyed(parent.focusChanged$, () => this.syncCwd())
      // A drag re-pins to the width it settled on, rather than reverting to proportional.
      this.subscribeUntilDestroyed(parent.splitAdjusted$, () => this.width.adopt())
    }
    this.width.attach()
    this.syncCwd()
    this.pollTimer = setInterval(() => this.syncCwd(), 2000)
  }

  ngOnDestroy(): void {
    clearInterval(this.pollTimer)
    this.width.detach()
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
    // A selection belongs to the directory it was made in; a plain refresh keeps it.
    this.clearSelection()
    this.load(next)
  }

  private async load(cwd: string | null): Promise<void> {
    const generation = ++this.generation
    this.error = null
    if (!cwd) {
      this.sessions = []
      this.sessionsCwd = cwd
      this.transport = null
      this.applyFilter()
      this.loading = false
      return
    }

    this.loading = true
    try {
      const runner = this.runnerFor(this.focusedSibling()?.session)
      this.transport = runner.remote ? `on ${runner.where}` : null
      const sessions = await listSessions(runner, cwd)
      if (generation !== this.generation) {
        return
      }
      // Parse, don't string-compare: modifiedAt carries a numeric offset, so lexical order breaks across offsets.
      this.sessions = sessions.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
      this.sessionsCwd = cwd
      this.applyFilter()
    } catch (e: any) {
      if (generation !== this.generation) {
        return
      }
      this.error = e.message ?? String(e)
      this.sessions = []
      this.sessionsCwd = cwd
      this.applyFilter()
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

  /** The terminal this list is tracking, and where a resume gets typed. */
  private focusedSibling(): any {
    return this.siblingCandidates()
      .find(t => t.session?.supportsWorkingDirectory?.()) ?? null
  }

  /**
   * asbutler must run where the sessions are. An SSH shell holds its SSHSession on
   * `.ssh`, whose `.ssh` is the live russh client — duck-typed, since the class name
   * does not survive minification.
   */
  private runnerFor(session: any): Runner {
    const client = session?.ssh?.ssh
    if (client?.openSessionChannel && client?.activateChannel) {
      return remoteRunner(client, session.ssh.profile?.options?.host ?? 'the remote host')
    }
    const bin = resolveBinary(this.bin)
    if (!bin) {
      throw new Error(
        `asbutler is not installed on this machine.\nLooked in ${SEARCH_DIRS.join(', ')} ` +
        `and $PATH for '${this.bin}'. Set agentSessions.binary in config.yaml if it lives elsewhere.`,
      )
    }
    return localRunner(bin)
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
