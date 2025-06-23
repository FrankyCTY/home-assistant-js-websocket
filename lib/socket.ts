/**
 * Create a web socket connection with a Home Assistant instance.
 */
import {
  ERR_INVALID_AUTH,
  ERR_CANNOT_CONNECT,
  ERR_HASS_HOST_REQUIRED,
} from "./errors.js";
import { Error } from "./types.js";
import type { ConnectionOptions } from "./connection.js";
import * as messages from "./messages.js";
import { atLeastHaVersion } from "./util.js";

const DEBUG = true;

export const MSG_TYPE_AUTH_REQUIRED = "auth_required";
export const MSG_TYPE_AUTH_INVALID = "auth_invalid";
export const MSG_TYPE_AUTH_OK = "auth_ok";

export interface HaWebSocket extends WebSocket {
  haVersion: string;
}

// TODO: Create socket connection to the ws endpoint, and set up event handlers.
// TODO: Perform auth phase + Feature enablement phase against hass instance ws endpoint.
// TODO: See: https://developers.home-assistant.io/docs/api/websocket/#authentication-phase
export function createSocket(options: ConnectionOptions): Promise<HaWebSocket> {
  console.log("================= Creating socket ==================");
  // TODO: No auth -> Ask user to provide the hassUrl so that we can retry getAuth().
  if (!options.auth) {
    throw ERR_HASS_HOST_REQUIRED;
  }
  const auth = options.auth;

  // Start refreshing expired tokens even before the WS connection is open.
  // We know that we will need auth anyway.
  // TODO: Token has expired, refresh it even we haven't connected to the WS yet as this is mandatory later anyway.
  let authRefreshTask = auth.expired
    ? auth.refreshAccessToken().then(
        () => {
          authRefreshTask = undefined;
        },
        () => {
          authRefreshTask = undefined;
        },
      )
    : undefined;

  // TODO: Convert from http:// -> ws://, https:// -> wss://
  const url = auth.wsUrl;

  if (DEBUG) {
    console.log("[Auth phase] Initializing", url);
  }

  // TODO: Connect to the ws endpoint, and set up event handlers.
  // TODO: Perform auth phase + Feature enablement phase against hass instance ws endpoint.
  // TODO: See: https://developers.home-assistant.io/docs/api/websocket/#authentication-phase
  function connect(
    triesLeft: number,
    promResolve: (socket: HaWebSocket) => void,
    promReject: (err: Error) => void,
  ) {
    if (DEBUG) {
      console.log("[Auth Phase] New connection", url);
    }

    // TODO: Starts trying to connect to the ws endpoint.
    // TODO: Note the socket instance is returned immediately, and the connection is established asynchronously so we can handle connection errors in the event handlers.
    const socket = new WebSocket(url) as HaWebSocket;

    // If invalid auth, we will not try to reconnect.
    // TODO: If TRUE: Auth message that contains token is sent to HASS instance but failed somehow.
    let invalidAuth = false;

    // TODO: Closing socket and retry reconnection if applicable.
    // TODO: Handle auth message failure.
    const closeMessage = () => {
      // If we are in error handler make sure close handler doesn't also fire.
      socket.removeEventListener("close", closeMessage);
      if (invalidAuth) {
        promReject(ERR_INVALID_AUTH);
        return;
      }

      // TODO: Reject if we no longer have to retry
      if (triesLeft === 0) {
        // TODO: We never were connected and will not retry as retry has been exhausted.
        promReject(ERR_CANNOT_CONNECT);
        return;
      }

      const newTries = triesLeft === -1 ? -1 : triesLeft - 1;
      // TODO: Retry again in a second
      setTimeout(() => connect(newTries, promResolve, promReject), 1000);
    };

    // Auth is mandatory, so we can send the auth message right away.
    // TODO: Socket is open, send the auth message to the ws server (hass instance) which includes the access token.
    const handleOpen = async (event: MessageEventInit) => {
      try {
        // TODO: If the token has expired, refresh it.
        if (auth.expired) {
          await (authRefreshTask ? authRefreshTask : auth.refreshAccessToken());
        }
        // TODO: Send the auth message to the WS server which includes the access token.
        // TODO: Authentication phase starts. https://developers.home-assistant.io/docs/api/websocket?_highlight=coalesce#authentication-phase
        socket.send(JSON.stringify(messages.auth(auth.accessToken)));
      } catch (err) {
        // Refresh token failed
        invalidAuth = err === ERR_INVALID_AUTH;
        // TODO: Close the socket, which will trigger the close handler.
        socket.close();
      }
    };

    // TODO: Handle messages from the WS server (hass instance).
    const handleMessage = async (event: MessageEvent) => {
      const message = JSON.parse(event.data);

      if (DEBUG) {
        console.log("[Auth phase] Received", message);
      }
      switch (message.type) {
        // TODO: WS server (hass instance) sent an auth invalid message back to us.
        case MSG_TYPE_AUTH_INVALID:
          invalidAuth = true;
          socket.close();
          break;

        // TODO: WS server "accept" our connection as our auth is valid.
        // TODO: Update ha core instance version in client side.
        case MSG_TYPE_AUTH_OK:
          // TODO: Auth phrase + Feature enablement phase completed, so we can remove the event handlers.
          socket.removeEventListener("open", handleOpen);
          socket.removeEventListener("message", handleMessage);
          socket.removeEventListener("close", closeMessage);
          socket.removeEventListener("error", closeMessage);
          socket.haVersion = message.ha_version;
          if (atLeastHaVersion(socket.haVersion, 2022, 9)) {
            socket.send(JSON.stringify(messages.supportedFeatures()));
          }

          promResolve(socket);
          break;

        default:
          if (DEBUG) {
            // We already send response to this message when socket opens
            // TODO: We expect command phrase and corresponding messages to come after the auth phase, so we are logging warning here.
            if (message.type !== MSG_TYPE_AUTH_REQUIRED) {
              console.warn("[Auth phase] Unhandled message", message);
            }
          }
      }
    };

    // TODO: These event listeners are only for the auth phrase + feature enablement phase. It is removed after the phases are completed.
    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", closeMessage);
    socket.addEventListener("error", closeMessage);
  }

  // TODO: Try to connect to the ws endpoint and register the event handlers to handle messages, open, close, error e.g.
  return new Promise((resolve, reject) =>
    connect(options.setupRetry, resolve, reject),
  );
}
