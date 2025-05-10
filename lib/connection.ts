/**
 * Connection that wraps a socket and provides an interface to interact with
 * the Home Assistant websocket API.
 */
import * as messages from "./messages.js";
import { ERR_INVALID_AUTH, ERR_CONNECTION_LOST } from "./errors.js";
import { HassEvent, MessageBase } from "./types.js";
import { HaWebSocket } from "./socket.js";
import type { Auth } from "./auth.js";

const DEBUG = false;

export type ConnectionOptions = {
  // TODO: Count of retries to connect to the WS server (HASS instance).
  setupRetry: number;
  auth?: Auth;
  createSocket: (options: ConnectionOptions) => Promise<HaWebSocket>;
};

// TODO: Fn with signature: (conn: Connection, eventData?: any) => void
export type ConnectionEventListener = (
  conn: Connection,
  eventData?: any,
) => void;

type Events = "ready" | "disconnected" | "reconnect-error";

type WebSocketPongResponse = {
  id: number;
  type: "pong";
};

type WebSocketEventResponse = {
  id: number;
  type: "event";
  event: HassEvent;
};

type WebSocketResultResponse = {
  id: number;
  type: "result";
  success: true;
  result: any;
};

type WebSocketResultErrorResponse = {
  id: number;
  type: "result";
  success: false;
  error: {
    code: string;
    message: string;
  };
};

type WebSocketResponse =
  | WebSocketPongResponse
  | WebSocketEventResponse
  | WebSocketResultResponse
  | WebSocketResultErrorResponse;

type SubscriptionUnsubscribe = () => Promise<void>;

// TODO: For Subscription command: Expect 1 "result" response + n "event" responses from server.
interface SubscribeEventCommmandInFlight<T> {
  resolve: (result?: any) => void;
  reject: (err: any) => void;
  callback: (ev: T) => void;
  subscribe: (() => Promise<SubscriptionUnsubscribe>) | undefined;
  unsubscribe: SubscriptionUnsubscribe;
}

// TODO: For Short live command: Represent the in flight command of the short live command that expect server response. (see sendMessagePromise())
type CommandWithAnswerInFlight = {
  resolve: (result?: any) => void;
  reject: (err: any) => void;
};

// TODO: Exclude fire and forget command (sendMessage()) as it is not expected to receive any response from server.
type CommandInFlight =
  | SubscribeEventCommmandInFlight<any>
  | CommandWithAnswerInFlight;

// TODO: Connection object: Higher-level API for sending commands and receiving events after the auth phase + feature enablement phase is completed.
export class Connection {
  options: ConnectionOptions;
  commandId: number;
  // TODO: Track in flight command that waits for server response(s).
  // TODO: Subscription command: Expect 1 "result" response + n "event" responses from server.
  // TODO: Short live command: Expect 1 "result" response from server.
  // TODO: Fire and forget command: sendMessage() DOES NOT register the command to the registry as it is fire and forget.
  CommandInFlightRegistry: Map<number, CommandInFlight>;
  eventListeners: Map<string, ConnectionEventListener[]>;
  // TODO: To ensure we don't reconnect when we want to close the connection.
  closeRequested: boolean;
  suspendReconnectPromise?: Promise<void>;

  oldCommandInFlightRegistry?: Map<number, CommandInFlight>;

  // TODO: PURPOSE: Suspend all send message, send message async, subscribeMessage calls that are queued DURING connection is suspended/disconnected.
  // TODO: Like a list of asyncio.Event() that are queued DURING connection is suspended/disconnected.
  // TODO: On reconnection (handleClose() -> _setSocket()), we will resolve these promises/asyncio.Event() to unblock the corresponding suspended new subscribeMessage calls e.g.
  // TODO: The resumes are kick started in the order of the queuedMessages list, which should be the order of the subscribeMessage() calls, and the command id is generated in the order of the subscribeMessage() calls IF the command id generation is in the task (callback)'s first synchronous execution before any syspension point (await).
  _queuedMessages?: Array<{
    resolve: (value?: unknown) => unknown;
    reject?: (err: typeof ERR_CONNECTION_LOST) => unknown;
  }>;
  socket?: HaWebSocket;
  /**
   * Version string of the Home Assistant instance. Set to version of last connection while reconnecting.
   */
  // @ts-ignore: incorrectly claiming it's not set in constructor.
  haVersion: string;

  constructor(socket: HaWebSocket, options: ConnectionOptions) {
    // connection options
    //  - setupRetry: amount of ms to retry when unable to connect on initial setup
    //  - createSocket: create a new Socket connection
    this.options = options;
    // id if next command to send
    this.commandId = 2; // TODO: Because socket may have sent command with id 1 at the start to enable features
    // info about active subscriptions and commands in flight
    this.CommandInFlightRegistry = new Map();
    // map of event listeners
    this.eventListeners = new Map();
    // true if a close is requested by the user
    this.closeRequested = false;

    this._setSocket(socket);
  }

  get connected() {
    // Using conn.socket.OPEN instead of WebSocket for better node support
    return (
      this.socket !== undefined && this.socket.readyState == this.socket.OPEN
    );
  }

  // TODO: Set the socket object
  // - Reattach event listeners.
  // - Re-subscribe to the backend based on old CommandInFlightRegistry set in _handleClose().
  // - Resolve all queued messages to unblock corresponding subscribeMessage() that are suspended.
  // - Notify that the connection is ready.
  private _setSocket(socket: HaWebSocket) {
    this.socket = socket;
    this.haVersion = socket.haVersion;
    // TODO: Reattach event listeners.
    socket.addEventListener("message", this._handleMessage);
    socket.addEventListener("close", this._handleClose);

    // TODO: Re-subscribe old subscriptions to the backend based on old CommandInFlightRegistry set in _handleClose().
    const oldCommandInFlightRegistry = this.oldCommandInFlightRegistry;
    if (oldCommandInFlightRegistry) {
      this.oldCommandInFlightRegistry = undefined;
      oldCommandInFlightRegistry.forEach((oldCommandInFlightInfo) => {
        // TODO: Case: Subscription command that can be resubscribed.
        // TODO: Action: Re-subscribe to the backend.
        if (
          "subscribe" in oldCommandInFlightInfo &&
          oldCommandInFlightInfo.subscribe
        ) {
          // TODO: On reconnection, we re-subscribe to the backend.
          oldCommandInFlightInfo.subscribe().then((unsub) => {
            oldCommandInFlightInfo.unsubscribe = unsub;
            // We need to resolve this in case it wasn't resolved yet.
            // This allows us to subscribe while we're disconnected
            // and recover properly.
            oldCommandInFlightInfo.resolve();
          });
        }
      });
    }
    const queuedMessages = this._queuedMessages;

    // TODO: Resolve all queued messages to unblock corresponding subscribeMessage() that are suspended.
    // TODO: The resumes are kick started in the order of the queuedMessages list, which should be the order of the subscribeMessage() calls, and the command id is generated in the order of the subscribeMessage() calls IF the command id generation is in the task (callback)'s first synchronous execution before any syspension point (await).
    if (queuedMessages) {
      this._queuedMessages = undefined;
      for (const queuedMsg of queuedMessages) {
        queuedMsg.resolve();
      }
    }

    // TODO: Notify that the connection is ready.
    this.fireEvent("ready");
  }

  // TODO: Register callback to the corresponding event type in the MAP.
  // TODO: {[eventType]: [callback1, callback2, ...]}
  addEventListener(eventType: Events, callback: ConnectionEventListener) {
    let listeners = this.eventListeners.get(eventType);

    // TODO: Register event listener for target event type in instance state.
    if (!listeners) {
      listeners = [];
      this.eventListeners.set(eventType, listeners);
    }

    listeners.push(callback);
  }

  removeEventListener(eventType: Events, callback: ConnectionEventListener) {
    const listeners = this.eventListeners.get(eventType);

    if (!listeners) {
      return;
    }

    const index = listeners.indexOf(callback);

    if (index !== -1) {
      listeners.splice(index, 1);
    }
  }

  // TODO: Fire "special" event like "ready", "disconnected", "reconnect-error" etc.
  fireEvent(eventType: Events, eventData?: any) {
    (this.eventListeners.get(eventType) || []).forEach((callback) =>
      callback(this, eventData),
    );
  }

  suspendReconnectUntil(suspendPromise: Promise<void>) {
    this.suspendReconnectPromise = suspendPromise;
  }

  // USERNOTE: From frontend, we suspend the connection when the DOM "freeze" event is triggered.
  suspend() {
    if (!this.suspendReconnectPromise) {
      throw new Error("Suspend promise not set");
    }
    if (this.socket) {
      this.socket.close();
    }
  }

  // TODO: Allow consumer to reconnect.
  // TODO: FORCE: Imperatively call _handleClose() by NOT relying on socket event handlers. Hint we remove the event handlers from the socket before calling _handleClose().
  /**
   * Reconnect the websocket connection.
   * @param force discard old socket instead of gracefully closing it.
   */
  reconnect(force = false) {
    if (!this.socket) {
      return;
    }
    if (!force) {
      this.socket.close();
      return;
    }
    this.socket.removeEventListener("message", this._handleMessage);
    this.socket.removeEventListener("close", this._handleClose);
    this.socket.close();
    this._handleClose();
  }

  // TODO: Close the socket without trying to reconnect.
  close() {
    this.closeRequested = true;
    if (this.socket) {
      this.socket.close();
    }
  }

  /**
   * Subscribe to a specific or all events.
   *
   * @param callback Callback  to be called when a new event fires
   * @param eventType
   * @returns promise that resolves to an unsubscribe function
   */
  async subscribeEvents<EventType>(
    callback: (ev: EventType) => void,
    eventType?: string,
  ): Promise<SubscriptionUnsubscribe> {
    return this.subscribeMessage(callback, messages.subscribeEvents(eventType));
  }

  ping() {
    console.log("ping----------->!");
    return this.sendMessagePromise(messages.ping());
  }

  // TODO: =============== Send Fire and forget command ===============
  // TODO: That's why we do not keep the command in flight in the client state (registry), as we do not expect any response from the server require us to handle.
  sendMessage(message: MessageBase, commandId?: number): void {
    if (!this.connected) {
      throw ERR_CONNECTION_LOST;
    }

    if (DEBUG) {
      console.log("Sending", message);
    }

    // TODO: Still in the queueing messages mode as we might still disconnect.
    // TODO: We can not queue with commandId in this mode, as the command ID will be generated when resolve the queued messages in _setSocket().
    if (this._queuedMessages) {
      if (commandId) {
        throw new Error("Cannot queue with commandId");
      }
      this._queuedMessages.push({ resolve: () => this.sendMessage(message) });
      return;
    }

    if (!commandId) {
      commandId = this._genCmdId();
    }
    message.id = commandId;

    this.socket!.send(JSON.stringify(message));
  }

  // TODO: =============== Send Short Live command but expect response ===============
  // TODO: Send one time command to server asynchronously. This handles registering the command to the in flight command registry.
  // TODO: Short live: Only expect 1 response with type "result" from server, no subsequent event responses expected like subscription.
  // TODO: https://developers.home-assistant.io/docs/api/websocket?_highlight=coalesce#calling-a-service-action
  sendMessagePromise<Result>(message: MessageBase): Promise<Result> {
    return new Promise((resolve, reject) => {
      // TODO: Block until the client has replayed all the previously queued messages/commands that are queued when connection is suspended/disconnected.
      // TODO: How? Uses event loop and suspend until this promise is resolved/rejected in _setSocket() after _handleClose() is called.
      if (this._queuedMessages) {
        this._queuedMessages!.push({
          reject,
          resolve: async () => {
            try {
              resolve(await this.sendMessagePromise(message));
            } catch (err) {
              reject(err);
            }
          },
        });
        return;
      }

      // TODO: Register message to in flight command registry.
      const commandId = this._genCmdId();
      // TODO: resolve: It is only invoked when "result" response is received from server to allow consumer to handle.
      this.CommandInFlightRegistry.set(commandId, { resolve, reject });
      this.sendMessage(message, commandId);
    });
  }

  /**
   * TODO: Sends a websocket message/command that starts a subscription on the backend.
   * TODO: Long Lived subscription: Expect 1 "result" response + n "event" responses from server.
   * TODO: https://developers.home-assistant.io/docs/api/websocket?_highlight=coalesce#subscribe-to-events
   *
   * @param message the message to start the subscription
   * @param callback the callback to be called when a new item arrives
   * @param [options.resubscribe] re-established a subscription after a reconnect. Defaults to true.
   * @returns promise that resolves to an unsubscribe function
   */
  async subscribeMessage<Result>(
    callback: (result: Result) => void,
    subscribeMessage: MessageBase,
    options?: {
      resubscribe?: boolean;
      preCheck?: () => boolean | Promise<boolean>;
    },
  ): Promise<SubscriptionUnsubscribe> {
    // TODO: Block until the client has replayed all the previously queued messages/commands that are queued when connection is suspended/disconnected.
    // TODO: How? Uses event loop and only continue when this promise is resolved/rejected.
    if (this._queuedMessages) {
      await new Promise((resolve, reject) => {
        this._queuedMessages!.push({ resolve, reject });
      });
    }

    // TODO: Pre-check before subscribing.
    if (options?.preCheck) {
      const precheck = await options.preCheck();
      if (!precheck) {
        throw new Error("Pre-check failed");
      }
    }

    let commandInFlightInfo: SubscribeEventCommmandInFlight<Result>;

    // TODO: Suspend until the server has processed it and responded with a "result" message (success or error).
    // See _handleMessage invoking resolve/reject of this promise.
    await new Promise((resolve, reject) => {
      // Command ID that will be used
      const commandId = this._genCmdId();

      // We store unsubscribe on info object. That way we can overwrite it in case
      // we get disconnected and we have to subscribe again.
      commandInFlightInfo = {
        // TODO: resolve: It is only invoked when "result" response is received from server indicates the subscription is active now.
        resolve,
        // TODO: reject: It is only invoked when "result" response is received from server indicates the subscription is rejected.
        reject,
        // TODO: callback: It is only invoked when "event" response is received, and contain the "hot" events this is subscribed for.
        callback,
        // TODO: For reconnection only: Allow resubscribe to the same subscription during reconnection.
        subscribe:
          options?.resubscribe !== false
            ? () => this.subscribeMessage(callback, subscribeMessage, options)
            : undefined,
        unsubscribe: async () => {
          // TODO: If connected to server, send message to server to unsubscribe on server side.
          if (this.connected) {
            await this.sendMessagePromise(
              messages.unsubscribeEvents(commandId),
            );
          }
          // TODO: Clean up from client side in flight command registry as we do not expect any more responses from server for this subscription.
          this.CommandInFlightRegistry.delete(commandId);
        },
      };
      // TODO: Register the inflight command for specific manipulations (e.g. unsubscribe).
      this.CommandInFlightRegistry.set(commandId, commandInFlightInfo);

      try {
        this.sendMessage(subscribeMessage, commandId);
      } catch (err) {
        // Happens when the websocket is already closing.
        // Don't have to handle the error, reconnect logic will pick it up.
        // TODO: We will do resubscribe in _setSocket(), as we will re-send subscription message to backend based on old CommandInFlightRegistry set in _handleClose().
      }
    });

    // TODO: Above promise is resolved/rejected, meaning the subscription is active/rejected by backend now.
    return () => commandInFlightInfo.unsubscribe();
  }

  // TODO: Handle server send respond messages.
  private _handleMessage = (event: MessageEvent) => {
    // TODO: Server might sends bulk responses in one message.
    let messageGroup: WebSocketResponse | WebSocketResponse[] = JSON.parse(
      event.data,
    );

    // TODO: Make message data always an array to simplify the code.
    if (!Array.isArray(messageGroup)) {
      messageGroup = [messageGroup];
    }

    // TODO: Handle all messages in the message group.
    messageGroup.forEach((message) => {
      if (DEBUG) {
        console.log("Received", message);
      }

      const commandInFlightInfo = this.CommandInFlightRegistry.get(message.id); // TODO: message id is the command id.

      switch (message.type) {
        // TODO: "Event" type response is only for subscriptions via (subscribeMessage()), and is expected to happen after "result" response.
        case "event":
          if (commandInFlightInfo) {
            // TODO: Invoke callback that expect events for this subscription.
            (
              commandInFlightInfo as SubscribeEventCommmandInFlight<any>
            ).callback(message.event);
          } else {
            // TODO: We don't know this subscription, so we unsubscribe from it.
            // TODO: Known subscription should have a corresponding command in flight info in the client state.
            console.warn(
              `Received event for unknown subscription ${message.id}. Unsubscribing.`,
            );
            this.sendMessagePromise(
              messages.unsubscribeEvents(message.id),
            ).catch((err) => {
              if (DEBUG) {
                console.warn(
                  ` Error unsubsribing from unknown subscription ${message.id}`,
                  err,
                );
              }
            });
          }
          break;

        // TODO: "Result" type response is for short live commands our acknowledgement of receiving the command (e.g. subscription).
        // TODO: For this, we ignore if the command is not in flight registry as it is usually caused by sendMessage() which is for short live commands that is not registered in the registry.
        case "result":
          // No info is fine. If just sendMessage is used, we did not store promise for result
          if (commandInFlightInfo) {
            if (message.success) {
              commandInFlightInfo.resolve(message.result);

              // Don't remove subscriptions.
              // TODO: Case: This server response is for the short live command previously sent from client.
              // TODO: So we remove it from the registry since it already received the response from server it expects.
              // TODO: How I determine that? This command can not be resubscribed (No subscribe callback registered).
              if (!("subscribe" in commandInFlightInfo)) {
                this.CommandInFlightRegistry.delete(message.id);
              }
            } else {
              // TODO: Case: The server rejected the command, we should not expect any more responses from server for all kind of commands we send.
              commandInFlightInfo.reject(message.error);
              this.CommandInFlightRegistry.delete(message.id);
            }
          }
          break;

        // TODO: Ping pong response. Response for the special kind of short live command that expect pong response from server.
        case "pong":
          if (commandInFlightInfo) {
            commandInFlightInfo.resolve();
            this.CommandInFlightRegistry.delete(message.id);
          } else {
            console.warn(`Received unknown pong response ${message.id}`);
          }
          break;

        default:
          if (DEBUG) {
            console.warn("Unhandled message", message);
          }
      }
    });
  };

  // TODO: Handle connection close event, if this is not intended to close the connection, we will retry indefinitely until the connection is re-established.
  private _handleClose = async () => {
    // reset to original state except haVersion
    this.commandId = 1;
    this.oldCommandInFlightRegistry = this.CommandInFlightRegistry;
    this.CommandInFlightRegistry = new Map();
    this.socket = undefined;

    // Reject in-flight sendMessagePromise requests
    this.oldCommandInFlightRegistry.forEach((oldCommandInFlightInfo) => {
      // FIXME: What is subscribeEvents commands?
      // We don't cancel subscribeEvents commands in flight
      // as we will be able to recover them.
      if (!("subscribe" in oldCommandInFlightInfo)) {
        oldCommandInFlightInfo.reject(
          messages.error(ERR_CONNECTION_LOST, "Connection lost"),
        );
      }
    });

    if (this.closeRequested) {
      return;
    }

    this.fireEvent("disconnected");

    // Disable setupRetry, we control it here with auto-backoff
    const options = { ...this.options, setupRetry: 0 };

    const reconnect = (tries: number) => {
      setTimeout(
        async () => {
          // TODO: No need to reconnect it is intended to close the connection.
          if (this.closeRequested) {
            return;
          }
          if (DEBUG) {
            console.log("Trying to reconnect");
          }
          try {
            // TODO: Recreate websocket object, handle auth phase + feature enablement phase for the initial connection.
            const socket = await options.createSocket(options);
            // TODO: Update the reference to the new socket object.
            this._setSocket(socket);
          } catch (err) {
            // TODO: Connection Failed: Reject all queued messages/commands that are queued when connection is suspended/disconnected.
            // FIXME: This reject queued messages on every reconnection attempt failure, and note we don't have max retries as we want to keep retrying indefinitely.
            if (this._queuedMessages) {
              const queuedMessages = this._queuedMessages;
              this._queuedMessages = undefined;
              for (const msg of queuedMessages) {
                if (msg.reject) {
                  msg.reject(ERR_CONNECTION_LOST);
                }
              }
            }
            if (err === ERR_INVALID_AUTH) {
              // TODO: Fire event for specific handling.
              this.fireEvent("reconnect-error", err);
            } else {
              // TODO: Retry.
              reconnect(tries + 1);
            }
          }
        },
        // TODO: Delay before retrying, scale per current retries count, but eventually cap at 5 seconds.
        Math.min(tries, 5) * 1000,
      );
    };

    if (this.suspendReconnectPromise) {
      await this.suspendReconnectPromise;
      this.suspendReconnectPromise = undefined;
      // For the first retry after suspend, we will queue up
      // all messages.
      this._queuedMessages = [];
    }

    // TODO: Start with retry count 0, we don't limit the max retries but this is used to calculate the delay before retrying.
    reconnect(0);
  };

  // TODO: The command IDs is expected to be monotonically increasing.
  private _genCmdId() {
    return ++this.commandId;
  }
}
