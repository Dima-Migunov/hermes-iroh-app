import type { AppNotice, ConnectionStatus, PromptEvent } from '@shared/protocol'

export type Unsubscribe = () => void

export class EventBus {
  private readonly promptListeners = new Set<(event: PromptEvent) => void>()
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>()
  private readonly historyListeners = new Set<() => void>()
  private readonly noticeListeners = new Set<(notice: AppNotice) => void>()

  onPromptEvent(listener: (event: PromptEvent) => void): Unsubscribe {
    this.promptListeners.add(listener)
    return () => this.promptListeners.delete(listener)
  }

  emitPromptEvent(event: PromptEvent): void {
    for (const listener of this.promptListeners) listener(event)
  }

  onConnectionStatus(listener: (status: ConnectionStatus) => void): Unsubscribe {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  emitConnectionStatus(status: ConnectionStatus): void {
    for (const listener of this.statusListeners) listener(status)
  }

  onHistoryChanged(listener: () => void): Unsubscribe {
    this.historyListeners.add(listener)
    return () => this.historyListeners.delete(listener)
  }

  emitHistoryChanged(): void {
    for (const listener of this.historyListeners) listener()
  }

  onNotice(listener: (notice: AppNotice) => void): Unsubscribe {
    this.noticeListeners.add(listener)
    return () => this.noticeListeners.delete(listener)
  }

  emitNotice(notice: AppNotice): void {
    for (const listener of this.noticeListeners) listener(notice)
  }
}
