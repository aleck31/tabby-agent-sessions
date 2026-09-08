import { BaseTabComponent, SplitContainer, SplitTabComponent } from 'tabby-core'

/** Single source for the default; index.ts feeds it to the ConfigProvider. */
export const DEFAULT_PANE_WIDTH_PX = 360

/**
 * Holds a pane at a pixel width inside Tabby's fractional split model. See ADR-0001 D2 —
 * every rule here was paid for by a bug, so read it before changing any of them.
 */
export class PaneWidth {
  /** The width to hold, in px; the ratio Tabby wants is recomputed from it. */
  private pinnedPx: number
  private readonly onWindowResize = () => this.hold()

  constructor(
    private tab: BaseTabComponent,
    private host: HTMLElement,
    configured: number | undefined,
  ) {
    this.pinnedPx = configured ?? DEFAULT_PANE_WIDTH_PX
  }

  /** Window resize only — a ResizeObserver here broke dragging. ADR-0001 D2. */
  attach(): void {
    window.addEventListener('resize', this.onWindowResize)
    this.hold()
  }

  detach(): void {
    window.removeEventListener('resize', this.onWindowResize)
  }

  /** Takes the width a drag settled on, read from the ratios rather than the animating DOM. */
  adopt(): void {
    const found = this.locate()
    if (!found) {
      return
    }
    const px = found.container.ratios[found.index] * this.containerPx(found.container)
    if (px > 0) {
      this.pinnedPx = px
    }
  }

  /** Re-derives the ratio so the pinned px width holds through a container resize. */
  hold(attempt = 0): void {
    const parent = this.tab.parent
    if (!(parent instanceof SplitTabComponent)) {
      return
    }
    // Mid-drag the user owns the width; correcting it here would fight the spanner.
    if ((parent as any)._spannerResizing) {
      return
    }
    const found = this.locate()
    if (!found || found.container.ratios.length < 2) {
      return
    }
    const { container, index } = found

    // On first insert the split area has no width yet; it lands a frame later.
    const containerPx = this.containerPx(container)
    if (!containerPx) {
      if (attempt < 10) {
        requestAnimationFrame(() => this.hold(attempt + 1))
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

  private locate(): { container: SplitContainer, index: number } | null {
    const parent = this.tab.parent
    if (!(parent instanceof SplitTabComponent)) {
      return null
    }
    const container = parent.getParentOf(this.tab)
    const index = container?.children.indexOf(this.tab) ?? -1
    return container && index >= 0 ? { container, index } : null
  }

  /**
   * Measures the split area, never the pane: panes carry a 0.125s width transition.
   * `container.w` is a percentage of that area, not px. See ADR-0001 D2.
   */
  private containerPx(container: SplitContainer): number {
    const areaPx = this.host.parentElement?.clientWidth ?? 0
    return areaPx * (container.w || 100) / 100
  }
}
