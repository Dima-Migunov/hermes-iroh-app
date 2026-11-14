import type { ClientConfig } from '@shared/protocol'
import { AppError, errorMessage } from './errors'
import { irohBindings } from './irohBindings'

export function validateServerTarget(config: ClientConfig): void {
  try {
    if (config.serverTicket) {
      irohBindings.ticketToAddr(config.serverTicket)
      return
    }
    if (config.serverNodeId) {
      irohBindings.nodeIdToAddr(config.serverNodeId, config.relayUrl)
      return
    }
  } catch (error) {
    throw new AppError(
      'configuration',
      `The server target is invalid. Check the endpoint ticket or NodeId. (${errorMessage(error)})`,
      { cause: error },
    )
  }
}
