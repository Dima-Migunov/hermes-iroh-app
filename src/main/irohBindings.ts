import { Endpoint, EndpointAddr, EndpointId, EndpointTicket, RelayMode } from '@number0/iroh'
import type { EndpointBindings } from './irohClient'

export const irohBindings: EndpointBindings = {
  bindEndpoint: (options, relayMode) =>
    Endpoint.bind(
      {
        secretKey: options.secretKey,
        alpns: options.alpns,
      },
      relayMode as RelayMode,
    ),
  ticketToAddr: (ticket) => EndpointTicket.fromString(ticket).endpointAddr(),
  nodeIdToAddr: (nodeId, relayUrl) => new EndpointAddr(EndpointId.fromString(nodeId), relayUrl),
  relayMode: (relayUrl) =>
    relayUrl ? RelayMode.customFromUrls([relayUrl]) : RelayMode.defaultMode(),
}
