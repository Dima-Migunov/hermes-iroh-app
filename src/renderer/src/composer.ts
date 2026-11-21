export type ComposerAction = 'send' | 'newline' | 'none'

export interface ComposerKeyInput {
  key: string
  shiftKey: boolean
  isComposing?: boolean
}

export function composerAction(input: ComposerKeyInput): ComposerAction {
  if (input.key !== 'Enter' || input.isComposing) return 'none'
  return input.shiftKey ? 'newline' : 'send'
}

export function isSubmittable(text: string): boolean {
  return text.trim().length > 0
}

export interface CancelKeyInput {
  key: string
  isComposing?: boolean
}

export function isCancelKey(input: CancelKeyInput): boolean {
  return input.key === 'Escape' && !input.isComposing
}
