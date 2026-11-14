import { readFile } from 'node:fs/promises'
import type { ClientConfig } from '@shared/protocol'
import { writeFileAtomic } from './atomicFile'
import { AppError, errorMessage } from '../errors'

export const DEFAULT_CONFIG: ClientConfig = {
  serverTicket: null,
  serverNodeId: null,
  relayUrl: null,
}

export type TargetValidator = (config: ClientConfig) => void

export interface ConfigLoadResult {
  config: ClientConfig
  warning?: string
}

export interface ConfigStoreOptions {
  filePath: string
  validateTarget?: TargetValidator
}

interface ConfigDocument extends ClientConfig {
  version: 1
}

export class ConfigStore {
  private readonly filePath: string
  private readonly validateTarget?: TargetValidator
  private cached: ClientConfig = { ...DEFAULT_CONFIG }
  private extraFields: Record<string, unknown> = {}

  constructor(options: ConfigStoreOptions) {
    this.filePath = options.filePath
    this.validateTarget = options.validateTarget
  }

  getCached(): ClientConfig {
    return { ...this.cached }
  }

  async load(): Promise<ConfigLoadResult> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) {
        this.cached = { ...DEFAULT_CONFIG }
        return { config: this.getCached() }
      }
      return {
        config: { ...DEFAULT_CONFIG },
        warning: `Settings could not be read from ${this.filePath}. Using defaults. (${errorMessage(error)})`,
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return {
        config: { ...DEFAULT_CONFIG },
        warning: `Settings file ${this.filePath} is not valid JSON. Using defaults until settings are saved again. (${errorMessage(error)})`,
      }
    }

    try {
      const { config, extra } = this.parseDocument(parsed)
      this.validateConfig(config)
      this.cached = config
      this.extraFields = extra
      return { config: this.getCached() }
    } catch (error) {
      return {
        config: { ...DEFAULT_CONFIG },
        warning: `Settings file ${this.filePath} is invalid. Using defaults until settings are saved again. (${errorMessage(error)})`,
      }
    }
  }

  async save(input: ClientConfig): Promise<ClientConfig> {
    const config = normalizeConfig(input)
    this.validateConfig(config)

    const document: ConfigDocument & Record<string, unknown> = {
      ...this.extraFields,
      version: 1,
      serverTicket: config.serverTicket,
      serverNodeId: config.serverNodeId,
      relayUrl: config.relayUrl,
    }

    try {
      await writeFileAtomic(this.filePath, `${JSON.stringify(document, null, 2)}\n`)
    } catch (error) {
      throw new AppError(
        'configuration',
        `Settings could not be saved to ${this.filePath}. (${errorMessage(error)})`,
        { cause: error },
      )
    }

    this.cached = config
    return this.getCached()
  }

  private parseDocument(value: unknown): { config: ClientConfig; extra: Record<string, unknown> } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new AppError('configuration', 'The settings document must be an object.')
    }

    const document = value as Record<string, unknown>
    const config = normalizeConfig({
      serverTicket: readNullableString(document.serverTicket, 'serverTicket'),
      serverNodeId: readNullableString(document.serverNodeId, 'serverNodeId'),
      relayUrl: readNullableString(document.relayUrl, 'relayUrl'),
    })

    const extra = { ...document }
    delete extra.version
    delete extra.serverTicket
    delete extra.serverNodeId
    delete extra.relayUrl

    return { config, extra }
  }

  private validateConfig(config: ClientConfig): void {
    const hasTicket = config.serverTicket !== null
    const hasNodeId = config.serverNodeId !== null

    if (!hasTicket && !hasNodeId) {
      throw new AppError(
        'configuration',
        'A server target is required: paste an endpoint ticket or a server NodeId.',
      )
    }

    if (config.relayUrl !== null) {
      let url: URL
      try {
        url = new URL(config.relayUrl)
      } catch {
        throw new AppError('configuration', 'The relay URL is not a valid URL.')
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new AppError('configuration', 'The relay URL must use http or https.')
      }
    }

    this.validateTarget?.(config)
  }
}

export function normalizeConfig(input: ClientConfig): ClientConfig {
  const ticket = typeof input.serverTicket === 'string' ? input.serverTicket.trim() : null
  const nodeId = typeof input.serverNodeId === 'string' ? input.serverNodeId.trim() : null
  const relay = typeof input.relayUrl === 'string' ? input.relayUrl.trim() : null

  const serverTicket = ticket ? ticket : null
  // An endpoint ticket already carries the server's addresses, so it wins over a bare NodeId.
  const serverNodeId = serverTicket === null && nodeId ? nodeId : null

  return {
    serverTicket,
    serverNodeId,
    relayUrl: relay ? relay : null,
  }
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new AppError('configuration', `The settings field "${field}" must be a string or null.`)
  }
  return value
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
