import type { Page } from '@playwright/test'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    // Written by recordComposerExposure; stops the sampler and returns what it counted.
    __composerExposure?: () => Record<string, number>
  }
}

// While the New worktree dialog creates out of sight it must cast nothing: this samples, on every DOM change and
// animation frame, whether a composer dialog is visible, an overlay exists, the app blurs or the body is locked.
export async function recordComposerExposure(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = {
      sampled: 0,
      visible: 0,
      overlay: 0,
      blurAttribute: 0,
      pointerLock: 0,
      blurred: 0
    }
    const sample = (): void => {
      const composers = Array.from(document.querySelectorAll('[data-slot="dialog-content"]'))
      if (document.querySelector('[cmdk-input]') || composers.length === 0) {
        return
      }
      seen.sampled += 1
      if (composers.some((dialog) => getComputedStyle(dialog).visibility !== 'hidden')) {
        seen.visible += 1
      }
      if (document.querySelector('[data-slot="dialog-overlay"]')) {
        seen.overlay += 1
      }
      if (document.body.hasAttribute('data-modal-overlay-open')) {
        seen.blurAttribute += 1
      }
      if (document.body.style.pointerEvents === 'none') {
        seen.pointerLock += 1
      }
      const scene = document.querySelector('.app-layout > :not(.window-controls)')
      if (scene && getComputedStyle(scene).filter !== 'none') {
        seen.blurred += 1
      }
    }
    const observer = new MutationObserver(sample)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    let stopped = false
    const frame = (): void => {
      sample()
      if (!stopped) {
        requestAnimationFrame(frame)
      }
    }
    frame()
    window.__composerExposure = () => {
      stopped = true
      observer.disconnect()
      return seen
    }
  })
}

export async function readComposerExposure(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => window.__composerExposure?.() ?? {})
}
