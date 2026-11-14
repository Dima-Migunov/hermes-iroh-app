import type { IpcApi } from '../shared/ipc'

declare global {
  interface Window {
    irohChannel: IpcApi
  }
}

export {}
