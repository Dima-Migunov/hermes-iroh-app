import type { ErrorCode } from '@shared/protocol'

export const ALLOWLIST_HINT =
  'Verify that this client NodeId is allowed on the server: run /iroh_allow <client_node_id> on the Hermes host.'

export class AppError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AppError'
    this.code = code
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function earlyCloseMessage(): string {
  return `The server closed the connection before sending a response. ${ALLOWLIST_HINT}`
}

export function serverErrorMessage(message: string): AppError {
  return new AppError('server', message)
}

interface MapContext {
  closedBeforeResponse?: boolean
}

export function mapIrohError(error: unknown, context: MapContext = {}): AppError {
  if (error instanceof AppError) {
    if (error.code === 'connection-closed' && context.closedBeforeResponse) {
      return new AppError('connection-closed', earlyCloseMessage(), { cause: error })
    }
    return error
  }

  const detail = errorMessage(error)
  const normalized = detail.toLowerCase()

  if (/timeout|timed out|deadline|etimedout/.test(normalized)) {
    return new AppError(
      'timeout',
      `The connection timed out. Check the server ticket or NodeId, the relay URL, and that the server is online. (${detail})`,
      { cause: error },
    )
  }

  if (/refused|econnrefused|reset|econnreset|not connected/.test(normalized)) {
    return new AppError(
      'connection-refused',
      `The server refused the connection. Check the server target and that the Hermes Iroh-channel plugin is running. (${detail})`,
      { cause: error },
    )
  }

  if (/closed|eof|finished|ended|aborted/.test(normalized)) {
    if (context.closedBeforeResponse) {
      return new AppError('connection-closed', earlyCloseMessage(), { cause: error })
    }
    return new AppError(
      'connection-closed',
      `The connection to the server was closed. Reconnect and try again. (${detail})`,
      { cause: error },
    )
  }

  if (/relay|network|unreachable|dns|socket|transport|enotfound|ehostunreach|enetunreach/.test(normalized)) {
    return new AppError(
      'network',
      `Network or relay failure. Check your internet connection and the relay URL. (${detail})`,
      { cause: error },
    )
  }

  return new AppError('network', `Could not reach the server. (${detail})`, { cause: error })
}
