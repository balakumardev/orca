import React, { useRef, useState } from 'react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  activityPaneRatioFromPointer,
  clampActivityPaneRatio,
  DEFAULT_ACTIVITY_PANE_RATIO,
  MIN_ACTIVITY_PANE_PX,
  MIN_WORKSPACE_PANE_PX
} from './sidebar-stacked-layout-math'

const KEYBOARD_STEP = 0.04

type SidebarStackedBodyProps = {
  activityOpen: boolean
  workspaces: React.ReactNode
  activityHeader: React.ReactNode
  activity: React.ReactNode
}

/** Workspace list on top, Activity below, a draggable splitter between; the split is per window and not persisted. */
export function SidebarStackedBody({
  activityOpen,
  workspaces,
  activityHeader,
  activity
}: SidebarStackedBodyProps): React.JSX.Element {
  const t = useTranslate()
  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(DEFAULT_ACTIVITY_PANE_RATIO)
  const [dragging, setDragging] = useState(false)

  const resizeFromPointer = (pointerY: number): void => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect && rect.height > 0) {
      setRatio(activityPaneRatioFromPointer(pointerY, rect))
    }
  }
  const resizeByKey = (delta: number): void => {
    const height = containerRef.current?.getBoundingClientRect().height ?? 0
    setRatio(clampActivityPaneRatio(ratio + delta, height))
  }

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-sidebar-stacked-body=""
    >
      <div className="flex min-h-0 flex-1 flex-col" data-sidebar-workspaces-pane="">
        {workspaces}
      </div>
      {activityOpen ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t(
            'auto.components.sidebar.SidebarStackedBody.resize',
            'Resize Activity pane'
          )}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          tabIndex={0}
          data-sidebar-activity-splitter=""
          className="group/splitter relative z-10 -my-1 flex h-2 shrink-0 cursor-row-resize items-center outline-none"
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragging(true)
          }}
          onPointerMove={(event) => {
            if (dragging) {
              resizeFromPointer(event.clientY)
            }
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            setDragging(false)
          }}
          onPointerCancel={() => setDragging(false)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault()
              resizeByKey(event.key === 'ArrowUp' ? KEYBOARD_STEP : -KEYBOARD_STEP)
            }
          }}
        >
          <div
            className={cn(
              'h-px w-full bg-border transition-colors group-hover/splitter:bg-ring/50 group-focus-visible/splitter:bg-ring',
              dragging && 'bg-ring'
            )}
          />
        </div>
      ) : null}
      <div
        className="flex min-h-0 shrink-0 flex-col"
        data-sidebar-activity-pane=""
        data-open={activityOpen ? 'true' : 'false'}
        style={
          activityOpen
            ? {
                flexBasis: `${ratio * 100}%`,
                minHeight: MIN_ACTIVITY_PANE_PX,
                maxHeight: `calc(100% - ${MIN_WORKSPACE_PANE_PX}px)`
              }
            : undefined
        }
      >
        {activityHeader}
        {activity}
      </div>
    </div>
  )
}
