import { contextBridge, ipcRenderer } from 'electron'
import { createBridge } from './bridge'

const bridge = createBridge(
  {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  },
  {
    on: (channel, listener) => {
      ipcRenderer.on(channel, listener)
    },
    removeListener: (channel, listener) => {
      ipcRenderer.removeListener(channel, listener)
    },
  },
)

contextBridge.exposeInMainWorld('irohChannel', bridge)
