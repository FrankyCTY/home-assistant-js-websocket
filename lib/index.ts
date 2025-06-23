// JS extensions in imports allow tsc output to be consumed by browsers.
import { createSocket } from "./socket.js";
import { Connection, ConnectionOptions } from "./connection.js";

export * from "./auth.js";
export * from "./collection.js";
export * from "./connection.js";
export * from "./config.js";
export * from "./services.js";
export * from "./entities.js";
export * from "./errors.js";
export * from "./socket.js";
export * from "./types.js";
export * from "./commands.js";
export * from "./store.js";

// TODO: Create websocket object, handle auth phase + feature enablement phase for the initial connection.
// TODO: Then return an abstraction (Connection object) for client to use for normal operations.
export async function createConnection(options?: Partial<ConnectionOptions>) {
  // TODO: Enrich options with default values.
  const connOptions: ConnectionOptions = {
    setupRetry: 0,
    createSocket,
    ...options,
  };

  // TODO: Create socket connection to the ws endpoint, and set up event handlers.
  // TODO: Perform auth phase + Feature enablement phase against hass instance ws endpoint.
  // TODO: See: https://developers.home-assistant.io/docs/api/websocket/#authentication-phase
  const socket = await connOptions.createSocket(connOptions);

  // TODO: ============= At this stage, the socket connection is established and the auth phase + feature enablement phase is completed, so we can create the custom connection object for client to use for normal operations. =============
  const conn = new Connection(socket, connOptions);
  return conn;
}
