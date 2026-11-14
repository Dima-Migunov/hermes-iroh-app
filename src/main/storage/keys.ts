import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from './atomicFile'
import { AppError, errorMessage } from '../errors'

export interface KeyMaterial {
  toBytes(): number[]
  public(): { toString(): string }
}

export interface KeyFactory {
  generate(): KeyMaterial
  fromBytes(bytes: number[]): KeyMaterial
}

export interface ClientIdentity {
  nodeId: string
  secretKeyBytes: Uint8Array
}

export interface KeyStoreOptions {
  filePath: string
  factory: KeyFactory
}

const KEY_BYTES = 32

export class KeyStore {
  private readonly filePath: string
  private readonly factory: KeyFactory
  private identity: ClientIdentity | null = null

  constructor(options: KeyStoreOptions) {
    this.filePath = options.filePath
    this.factory = options.factory
  }

  async load(): Promise<ClientIdentity> {
    if (this.identity) return this.identity

    let existing: Buffer
    try {
      existing = await readFile(this.filePath)
    } catch (error) {
      if (isMissingFile(error)) {
        this.identity = await this.create()
        return this.identity
      }
      throw new AppError(
        'identity',
        `The client key at ${this.filePath} could not be read. Restore it from backup, or deliberately remove it to generate a new identity. (${errorMessage(error)})`,
        { cause: error },
      )
    }

    if (existing.length !== KEY_BYTES) {
      throw new AppError(
        'identity',
        `The client key at ${this.filePath} is invalid: expected ${KEY_BYTES} bytes but found ${existing.length}. The file was left unchanged. Restore it from backup, or deliberately remove it to generate a new identity.`,
      )
    }

    this.identity = this.toIdentity(Array.from(existing))
    return this.identity
  }

  getNodeId(): string | null {
    return this.identity?.nodeId ?? null
  }

  private async create(): Promise<ClientIdentity> {
    const material = this.factory.generate()
    const bytes = new Uint8Array(material.toBytes())
    if (bytes.length !== KEY_BYTES) {
      throw new AppError('identity', 'The native Iroh key generator produced an invalid key length.')
    }

    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      await writeFileAtomic(this.filePath, bytes, 0o600)
    } catch (error) {
      throw new AppError(
        'identity',
        `A new client key could not be written to ${this.filePath}. Check the directory permissions. (${errorMessage(error)})`,
        { cause: error },
      )
    }

    return this.toIdentity(Array.from(bytes))
  }

  private toIdentity(bytes: number[]): ClientIdentity {
    try {
      const material = this.factory.fromBytes(bytes)
      return {
        nodeId: material.public().toString(),
        secretKeyBytes: Uint8Array.from(bytes),
      }
    } catch (error) {
      throw new AppError(
        'identity',
        `The client key at ${this.filePath} is not a valid Iroh secret key. The file was left unchanged. (${errorMessage(error)})`,
        { cause: error },
      )
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
