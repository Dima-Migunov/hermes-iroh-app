import { useEffect, useState } from 'react'

export interface SidebarState {
  expanded: boolean
  toggle: () => void
  close: () => void
}

export function useSidebarState(compact: boolean): SidebarState {
  const [wideOpen, setWideOpen] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    if (compact) setDrawerOpen(false)
  }, [compact])

  return {
    expanded: compact ? drawerOpen : wideOpen,
    toggle: () => {
      if (compact) {
        setDrawerOpen((open) => !open)
      } else {
        setWideOpen((open) => !open)
      }
    },
    close: () => setDrawerOpen(false),
  }
}
