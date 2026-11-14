import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientConfig } from '@shared/protocol'
import { AppError } from '@main/errors'
import { ConfigStore, type TargetValidator } from '@main/storage/config'

const directories: string[] = []

async function temporaryStore(validator?: TargetValidator): Promise<{
  directory: string
  filePath: string
  store: ConfigStore
}> {
  const directory = await mkdtemp(join(tmpdir(), 'iroh-config-'))
  directories.push(directory)
  const filePath = join(directory, 'config.json')
  return { directory, filePath, store: new ConfigStore({ filePath, validateTarget: validator }) }
}

const ticketConfig: ClientConfig = {
  serverTicket: 'valid-ticket-value-1234567890',
  serverNodeId: null,
  relayUrl: null,
}

const rejectBadTargets: TargetValidator = (config) => {
  if (config.serverTicket === 'bad-ticket' || config.serverNodeId === 'bad-node') {
    throw new AppError('configuration', 'The server target is invalid.')
  }
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

describe('ConfigStore', () => {
  it('saves and loads a valid configuration', async () => {
    const { store, filePath } = await temporaryStore()
    const saved = await store.save({
      serverTicket: '  ticket-value  ',
      serverNodeId: null,
      relayUrl: 'https://relay.example',
    })

    expect(saved).toEqual({
      serverTicket: 'ticket-value',
      serverNodeId: null,
      relayUrl: 'https://relay.example',
    })

    const reloaded = await new ConfigStore({ filePath }).load()
    expect(reloaded.config).toEqual(saved)
    expect(reloaded.warning).toBeUndefined()
  })

  it('keeps the ticket and drops the NodeId when both targets are set', async () => {
    const { store, filePath } = await temporaryStore()

    const saved = await store.save({
      serverTicket: 'ticket',
      serverNodeId: 'node',
      relayUrl: null,
    })

    expect(saved).toEqual({ serverTicket: 'ticket', serverNodeId: null, relayUrl: null })

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    expect(raw.serverTicket).toBe('ticket')
    expect(raw.serverNodeId).toBeNull()
  })

  it('rejects neither target being set', async () => {
    const { store } = await temporaryStore()
    const error = await store
      .save({ serverTicket: null, serverNodeId: null, relayUrl: null })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('configuration')
    expect((error as AppError).message).toMatch(/server target is required/i)
  })

  it('loads a document holding both targets by keeping the ticket', async () => {
    const { store, filePath } = await temporaryStore()
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, serverTicket: 'ticket', serverNodeId: 'node', relayUrl: null }),
    )

    const loaded = await store.load()

    expect(loaded.config).toEqual({ serverTicket: 'ticket', serverNodeId: null, relayUrl: null })
    expect(loaded.warning).toBeUndefined()
  })

  it('rejects an invalid relay URL', async () => {
    const { store } = await temporaryStore()
    await expect(
      store.save({ serverTicket: 'ticket', serverNodeId: null, relayUrl: 'not a url' }),
    ).rejects.toMatchObject({ code: 'configuration' })
  })

  it('recovers from malformed JSON with a warning', async () => {
    const { store, filePath } = await temporaryStore()
    await writeFile(filePath, '{broken json')

    const loaded = await store.load()
    expect(loaded.config).toEqual({ serverTicket: null, serverNodeId: null, relayUrl: null })
    expect(loaded.warning).toMatch(/not valid JSON/i)
  })

  it('treats a structurally invalid document as unconfigured', async () => {
    const { store, filePath } = await temporaryStore()
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, serverTicket: 42, serverNodeId: null, relayUrl: null }),
    )

    const loaded = await store.load()
    expect(loaded.config.serverTicket).toBeNull()
    expect(loaded.warning).toBeDefined()
  })

  it('preserves the last valid settings when a save is rejected', async () => {
    const { store, filePath } = await temporaryStore(rejectBadTargets)
    await store.save(ticketConfig)

    await expect(
      store.save({ serverTicket: 'bad-ticket', serverNodeId: null, relayUrl: null }),
    ).rejects.toMatchObject({ code: 'configuration' })

    const loaded = await new ConfigStore({ filePath }).load()
    expect(loaded.config.serverTicket).toBe(ticketConfig.serverTicket)
  })

  it('preserves unknown fields across a load and save', async () => {
    const { store, filePath } = await temporaryStore()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        serverTicket: 'old-ticket',
        serverNodeId: null,
        relayUrl: null,
        futureField: 'kept',
      }),
    )

    await store.load()
    await store.save({ ...ticketConfig })

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    expect(raw.futureField).toBe('kept')
    expect(raw.version).toBe(1)
  })
})
