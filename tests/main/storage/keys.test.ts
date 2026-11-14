import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '@main/errors'
import { KeyStore, type KeyFactory, type KeyMaterial } from '@main/storage/keys'

class FakeKeyMaterial implements KeyMaterial {
  constructor(private readonly bytes: number[]) {}

  toBytes(): number[] {
    return [...this.bytes]
  }

  public(): { toString(): string } {
    return { toString: () => `node-${this.bytes[0]}-${this.bytes.length}` }
  }
}

const factory: KeyFactory = {
  generate: () => new FakeKeyMaterial(Array.from({ length: 32 }, (_value, index) => index)),
  fromBytes: (bytes) => {
    if (bytes.length !== 32) throw new Error('invalid key length')
    return new FakeKeyMaterial(bytes)
  },
}

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'iroh-keys-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
  )
})

describe('KeyStore', () => {
  it('creates a 32-byte key on first launch with owner-only permissions', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'client.key')
    const store = new KeyStore({ filePath, factory })

    const identity = await store.load()

    expect(identity.nodeId).toBe('node-0-32')
    expect(identity.secretKeyBytes).toHaveLength(32)
    expect(Array.from(await readFile(filePath))).toEqual(Array.from(identity.secretKeyBytes))

    if (process.platform !== 'win32') {
      const mode = (await stat(filePath)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('loads the same identity on later launches', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'client.key')

    const first = await new KeyStore({ filePath, factory }).load()
    const second = await new KeyStore({ filePath, factory }).load()

    expect(second.nodeId).toBe(first.nodeId)
    expect(Array.from(second.secretKeyBytes)).toEqual(Array.from(first.secretKeyBytes))
  })

  it('rejects a malformed key without overwriting it', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'client.key')
    const malformed = new Uint8Array(31).fill(7)
    await writeFile(filePath, malformed)

    const store = new KeyStore({ filePath, factory })
    await expect(store.load()).rejects.toMatchObject({ code: 'identity' })
    expect(new Uint8Array(await readFile(filePath))).toEqual(malformed)
  })

  it('reports an unreadable key path without replacing it', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'client.key')
    await mkdir(filePath)

    const store = new KeyStore({ filePath, factory })
    await expect(store.load()).rejects.toBeInstanceOf(AppError)
    await expect(store.load()).rejects.toMatchObject({ code: 'identity' })
    expect((await stat(filePath)).isDirectory()).toBe(true)
  })

  it('rejects keys the native layer cannot parse', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'client.key')
    const bytes = new Uint8Array(32).fill(3)
    await writeFile(filePath, bytes)

    const brokenFactory: KeyFactory = {
      ...factory,
      fromBytes: () => {
        throw new Error('invalid key material')
      },
    }
    const store = new KeyStore({ filePath, factory: brokenFactory })

    await expect(store.load()).rejects.toMatchObject({ code: 'identity' })
    expect(new Uint8Array(await readFile(filePath))).toEqual(bytes)
  })
})
