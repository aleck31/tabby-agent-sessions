import { CommonModule } from '@angular/common'
import { Injectable, NgModule } from '@angular/core'
import {
  AppService,
  ConfigProvider,
  SplitTabComponent,
  TabsService,
  ToolbarButton,
  ToolbarButtonProvider,
} from 'tabby-core'

import { DEFAULT_PANE_WIDTH_PX } from './paneWidth'
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
    await top.addTab(panel, relative, 'r')
    // Width is the pane's own business — it has to hold it across window resizes.
  }
}

/** Needs asbutler >= 0.6.1; set an absolute path here if it's not on PATH. */
@Injectable()
export class AgentSessionsConfigProvider extends ConfigProvider {
  defaults = {
    agentSessions: {
      binary: 'asbutler',
      /** px, not a ratio — see DEFAULT_PANE_WIDTH_PX and the pane's holdWidth(). */
      width: DEFAULT_PANE_WIDTH_PX,
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
