import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@renderer/components/Composer'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null = null
let container: HTMLDivElement | null = null

function mount(element: React.ReactElement): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root?.render(element))
}

function textarea(): HTMLTextAreaElement {
  return container!.querySelector('textarea') as HTMLTextAreaElement
}

function type(value: string): void {
  const field = textarea()
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressEnter(): Promise<void> {
  await act(async () => {
    textarea().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    await Promise.resolve()
  })
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('Composer draft handling', () => {
  it('restores the draft when a send reports it did not start', async () => {
    const onSend = vi.fn(async () => false)
    mount(
      <Composer
        disabled={false}
        generating={false}
        onSend={onSend}
        onStop={() => undefined}
      />,
    )

    type('keep me')
    await pressEnter()

    expect(onSend).toHaveBeenCalledWith('keep me')
    expect(textarea().value).toBe('keep me')
  })

  it('restores the draft when the send rejects', async () => {
    const onSend = vi.fn(async () => {
      throw new Error('transport failed')
    })
    mount(
      <Composer
        disabled={false}
        generating={false}
        onSend={onSend}
        onStop={() => undefined}
      />,
    )

    type('try again')
    await pressEnter()

    expect(textarea().value).toBe('try again')
  })

  it('clears the draft when the send starts', async () => {
    const onSend = vi.fn(async () => true)
    mount(
      <Composer
        disabled={false}
        generating={false}
        onSend={onSend}
        onStop={() => undefined}
      />,
    )

    type('sent text')
    await pressEnter()

    expect(textarea().value).toBe('')
  })

  it('does not submit twice while a send is in flight', async () => {
    let release!: (value: boolean) => void
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
    )
    mount(
      <Composer
        disabled={false}
        generating={false}
        onSend={onSend}
        onStop={() => undefined}
      />,
    )

    type('only once')
    await pressEnter()
    await pressEnter()

    expect(onSend).toHaveBeenCalledTimes(1)

    await act(async () => {
      release(true)
      await Promise.resolve()
    })
  })

  it('restores an emptied field after a rejected send so text is not lost', async () => {
    const onSend = vi.fn(async () => false)
    mount(
      <Composer
        disabled={false}
        generating={false}
        onSend={onSend}
        onStop={() => undefined}
      />,
    )

    type('draft')
    await pressEnter()

    const field = textarea()
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    act(() => {
      setter?.call(field, 'draft edited after failure')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(textarea().value).toBe('draft edited after failure')
  })
})
