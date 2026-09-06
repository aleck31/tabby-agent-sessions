import { CommonModule } from '@angular/common'
import { Injectable, NgModule } from '@angular/core'
import {
  AppService,
  ConfigProvider,
  ConfigService,
  SplitContainer,
  SplitTabComponent,
  TabsService,
  ToolbarButton,
  ToolbarButtonProvider,
} from 'tabby-core'

import { SessionListTabComponent } from './sessionList.component'

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
  <rect x="1" y="2" width="4.5" height="12" rx="1" opacity=".55"/>
  <rect x="7" y="2" width="8" height="12" rx="1" opacity=".9"/>
</svg>`

@Injectable()
export class AgentSessionsButtonProvider extends ToolbarButtonProvider {
  constructor(
    private app: AppService,
    private tabs: TabsService,
    private config: ConfigService,
  ) {
    super()
  }

  provide(): ToolbarButton[] {
    return [{
      icon: ICON,
      title: 'Agent Sessions',
      weight: 5,
      click: () => this.toggle(),
    }]
  }

  /** Tabby has no sidebar API — a split pane holding our own tab is the supported equivalent. */
  private async toggle(): Promise<void> {
    const top = this.app.activeTab
    if (!(top instanceof SplitTabComponent)) {
      return
    }

    const existing = top.getAllTabs().find(t => t instanceof SessionListTabComponent)
    if (existing) {
      existing.destroy()
      return
    }

    const relative = top.getFocusedTab() ?? top.getAllTabs()[0] ?? null
    const panel = this.tabs.create({ type: SessionListTabComponent })
    await top.addTab(panel, relative, 'l')
    this.applyRatio(top, panel)
  }

  /** Initial width only — the spanner stays draggable afterwards. */
  private applyRatio(top: SplitTabComponent, panel: SessionListTabComponent): void {
    const share = this.config.store.agentSessions?.width ?? 0.3
    const container: SplitContainer | null = top.getParentOf(panel)
    const index = container?.children.indexOf(panel) ?? -1
    if (!container || index < 0 || container.ratios.length < 2) {
      return
    }

    const rest = container.ratios.reduce((sum, r, i) => i === index ? sum : sum + r, 0)
    const siblings = container.ratios.length - 1
    container.ratios = container.ratios.map((r, i) =>
      i === index
        ? share
        : rest > 0 ? r / rest * (1 - share) : (1 - share) / siblings,
    )
    top.layout()
  }
}

/** Needs asbutler >= 0.6.0 (JSON by default); set an absolute path here if it's not on PATH. */
@Injectable()
export class AgentSessionsConfigProvider extends ConfigProvider {
  defaults = {
    agentSessions: {
      binary: 'asbutler',
      width: 0.3,
    },
  }
}

@NgModule({
  imports: [CommonModule],
  declarations: [SessionListTabComponent],
  providers: [
    { provide: ToolbarButtonProvider, useClass: AgentSessionsButtonProvider, multi: true },
    { provide: ConfigProvider, useClass: AgentSessionsConfigProvider, multi: true },
  ],
})
export default class AgentSessionsModule { }

export { SessionListTabComponent }
