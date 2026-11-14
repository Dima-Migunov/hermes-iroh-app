import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, clipboard, dialog, ipcMain, session as electronSession } from 'electron'
import { IPC } from '@shared/ipc'
import { PRODUCTION_CSP } from '@shared/csp'
import { EventBus } from './eventBus'
import { errorMessage } from './errors'
import { IrohClient } from './irohClient'
import { irohBindings } from './irohBindings'
import { registerIpcHandlers } from './ipc'
import type { IpcMainLike } from './ipc'
import { PromptCoordinator } from './promptCoordinator'
import { SessionStore } from './sessions/sessionStore'
import { validateServerTarget } from './targets'
import { ConfigStore } from './storage/config'
import { HistoryStore } from './storage/history'
import { irohKeyFactory } from './storage/irohKeys'
import { KeyStore } from './storage/keys'

const isDevelopment = Boolean(process.env.ELECTRON_RENDERER_URL)
const rendererDirectoryUrl = pathToFileURL(join(__dirname, '../renderer/')).href
const allowedUrlPrefixes = isDevelopment
  ? [process.env.ELECTRON_RENDERER_URL ?? '', rendererDirectoryUrl]
  : [rendererDirectoryUrl]

let mainWindow: BrowserWindow | null = null
let quitStarted = false

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#101418',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!allowedUrlPrefixes.some((prefix) => prefix.length > 0 && url.startsWith(prefix))) {
      event.preventDefault()
    }
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  if (isDevelopment && process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow = window
  return window
}

async function bootstrap(): Promise<void> {
  await app.whenReady()

  if (!isDevelopment) {
    electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [PRODUCTION_CSP],
        },
      })
    })
  }

  const userDataDirectory = app.getPath('userData')
  const keyStore = new KeyStore({
    filePath: join(userDataDirectory, 'client.key'),
    factory: irohKeyFactory,
  })

  let identity: Awaited<ReturnType<KeyStore['load']>>
  try {
    identity = await keyStore.load()
  } catch (error) {
    dialog.showErrorBox('Client identity error', errorMessage(error))
    app.quit()
    return
  }

  const configStore = new ConfigStore({
    filePath: join(userDataDirectory, 'config.json'),
    validateTarget: validateServerTarget,
  })
  const configResult = await configStore.load()

  const sessionStore = new SessionStore(new HistoryStore(join(userDataDirectory, 'history')))
  try {
    await sessionStore.initialize()
  } catch (error) {
    dialog.showErrorBox('Chat history error', errorMessage(error))
    app.quit()
    return
  }

  const bus = new EventBus()
  const notices = [configResult.warning, ...sessionStore.getWarnings()].filter(
    (warning): warning is string => typeof warning === 'string',
  )

  const client = new IrohClient({
    secretKeyBytes: identity.secretKeyBytes,
    bindings: irohBindings,
    getConfig: () => configStore.getCached(),
    onStatus: (status) => bus.emitConnectionStatus(status),
  })

  const coordinator = new PromptCoordinator({
    client,
    sessions: sessionStore,
    bus,
  })

  sessionStore.onDidChange(() => bus.emitHistoryChanged())

  const sendToRenderer = (channel: string, payload: unknown): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send(channel, payload)
  }

  bus.onPromptEvent((event) => sendToRenderer(IPC.promptEvent, event))
  bus.onConnectionStatus((status) => sendToRenderer(IPC.connectionStatusChanged, status))
  bus.onHistoryChanged(() => sendToRenderer(IPC.historyChanged, undefined))
  bus.onNotice((notice) => sendToRenderer(IPC.notice, notice))

  registerIpcHandlers(ipcMain as unknown as IpcMainLike, {
    identity: { nodeId: identity.nodeId },
    configStore,
    connection: client,
    sessions: sessionStore,
    prompts: coordinator,
    copyText: (text) => clipboard.writeText(text),
    notices,
    allowedUrlPrefixes,
  })

  await createWindow()

  const config = configStore.getCached()
  if (config.serverTicket || config.serverNodeId) {
    void client.connect()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })

  app.on('before-quit', (event) => {
    if (quitStarted) return
    event.preventDefault()
    quitStarted = true

    void (async () => {
      await coordinator.shutdown().catch(() => undefined)
      await client.close().catch(() => undefined)
      app.exit(0)
    })()
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

void bootstrap().catch((error: unknown) => {
  dialog.showErrorBox('Startup failed', errorMessage(error))
  app.quit()
})
