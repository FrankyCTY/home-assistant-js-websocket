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
  setupRetry: number;
  auth?: Auth;
  createSocket: (options: ConnectionOptions) => Promise<HaWebSocket>;
};

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

interface SubscribeEventCommmandInFlight<T> {
  resolve: (result?: any) => void;
  reject: (err: any) => void;
  callback: (ev: T) => void;
  subscribe: (() => Promise<SubscriptionUnsubscribe>) | undefined;
  unsubscribe: SubscriptionUnsubscribe;
}

type CommandWithAnswerInFlight = {
  resolve: (result?: any) => void;
  reject: (err: any) => void;
};

type CommandInFlight =
  | SubscribeEventCommmandInFlight<any>
  | CommandWithAnswerInFlight;

export class Connection {
  options: ConnectionOptions;
  commandId: number;
  commands: Map<number, CommandInFlight>;
  eventListeners: Map<string, ConnectionEventListener[]>;
  closeRequested: boolean;
  suspendReconnectPromise?: Promise<void>;

  oldSubscriptions?: Map<number, CommandInFlight>;

  // We use this to queue messages in flight for the first reconnect
  // after the connection has been suspended.
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
    this.commandId = 2; // socket may send 1 at the start to enable features
    // info about active subscriptions and commands in flight
    this.commands = new Map();
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

  private _setSocket(socket: HaWebSocket) {
    this.socket = socket;
    this.haVersion = socket.haVersion;
    socket.addEventListener("message", this._handleMessage);
    socket.addEventListener("close", this._handleClose);

    const oldSubscriptions = this.oldSubscriptions;
    if (oldSubscriptions) {
      this.oldSubscriptions = undefined;
      oldSubscriptions.forEach((info) => {
        if ("subscribe" in info && info.subscribe) {
          info.subscribe().then((unsub) => {
            info.unsubscribe = unsub;
            // We need to resolve this in case it wasn't resolved yet.
            // This allows us to subscribe while we're disconnected
            // and recover properly.
            info.resolve();
          });
        }
      });
    }
    const queuedMessages = this._queuedMessages;

    if (queuedMessages) {
      this._queuedMessages = undefined;
      for (const queuedMsg of queuedMessages) {
        queuedMsg.resolve();
      }
    }

    this.fireEvent("ready");
  }

  addEventListener(eventType: Events, callback: ConnectionEventListener) {
    let listeners = this.eventListeners.get(eventType);

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

  fireEvent(eventType: Events, eventData?: any) {
    (this.eventListeners.get(eventType) || []).forEach((callback) =>
      callback(this, eventData),
    );
  }

  suspendReconnectUntil(suspendPromise: Promise<void>) {
    this.suspendReconnectPromise = suspendPromise;
  }

  suspend() {
    if (!this.suspendReconnectPromise) {
      throw new Error("Suspend promise not set");
    }
    if (this.socket) {
      this.socket.close();
    }
  }

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
    return this.sendMessagePromise(messages.ping());
  }

  sendMessage(message: MessageBase, commandId?: number): void {
    if (!this.connected) {
      throw ERR_CONNECTION_LOST;
    }

    if (DEBUG) {
      console.log("Sending", message);
    }

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

  sendMessagePromise<Result>(message: MessageBase): Promise<Result> {
    return new Promise((resolve, reject) => {
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

      const commandId = this._genCmdId();
      this.commands.set(commandId, { resolve, reject });
      this.sendMessage(message, commandId);
    });
  }

  /**
   * Call a websocket command that starts a subscription on the backend.
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
    if (this._queuedMessages) {
      await new Promise((resolve, reject) => {
        this._queuedMessages!.push({ resolve, reject });
      });
    }

    if (options?.preCheck) {
      const precheck = await options.preCheck();
      if (!precheck) {
        throw new Error("Pre-check failed");
      }
    }

    let info: SubscribeEventCommmandInFlight<Result>;

    await new Promise((resolve, reject) => {
      // Command ID that will be used
      const commandId = this._genCmdId();

      // We store unsubscribe on info object. That way we can overwrite it in case
      // we get disconnected and we have to subscribe again.
      info = {
        resolve,
        reject,
        callback,
        subscribe:
          options?.resubscribe !== false
            ? () => this.subscribeMessage(callback, subscribeMessage, options)
            : undefined,
        unsubscribe: async () => {
          // No need to unsubscribe if we're disconnected
          if (this.connected) {
            await this.sendMessagePromise(
              messages.unsubscribeEvents(commandId),
            );
          }
          this.commands.delete(commandId);
        },
      };
      this.commands.set(commandId, info);

      try {
        this.sendMessage(subscribeMessage, commandId);
      } catch (err) {
        // Happens when the websocket is already closing.
        // Don't have to handle the error, reconnect logic will pick it up.
      }
    });

    return () => info.unsubscribe();
  }

  private _handleMessage = (event: MessageEvent) => {
    let messageGroup: WebSocketResponse | WebSocketResponse[] = JSON.parse(
      event.data,
    );

    if (!Array.isArray(messageGroup)) {
      messageGroup = [messageGroup];
    }

    messageGroup.forEach((message) => {
      if (DEBUG) {
        console.log("Received", message);
      }

      const info = this.commands.get(message.id);

      switch (message.type) {
        case "event":
          if (info) {
            (info as SubscribeEventCommmandInFlight<any>).callback(
              message.event,
            );
          } else {
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

        case "result":
          // No info is fine. If just sendMessage is used, we did not store promise for result
          if (info) {
            if (message.success) {
              info.resolve(message.result);

              // Don't remove subscriptions.
              if (!("subscribe" in info)) {
                this.commands.delete(message.id);
              }
            } else {
              info.reject(message.error);
              this.commands.delete(message.id);
            }
          }
          break;

        case "pong":
          if (info) {
            info.resolve();
            this.commands.delete(message.id);
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

  private _handleClose = async () => {
    const oldCommands = this.commands;

    // reset to original state except haVersion
    this.commandId = 1;
    this.oldSubscriptions = this.commands;
    this.commands = new Map();
    this.socket = undefined;

    // Reject in-flight sendMessagePromise requests
    oldCommands.forEach((info) => {
      // We don't cancel subscribeEvents commands in flight
      // as we will be able to recover them.
      if (!("subscribe" in info)) {
        info.reject(messages.error(ERR_CONNECTION_LOST, "Connection lost"));
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
          if (this.closeRequested) {
            return;
          }
          if (DEBUG) {
            console.log("Trying to reconnect");
          }
          try {
            const socket = await options.createSocket(options);
            this._setSocket(socket);
          } catch (err) {
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
              this.fireEvent("reconnect-error", err);
            } else {
              reconnect(tries + 1);
            }
          }
        },
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

    reconnect(0);
  };

  private _genCmdId() {
    return ++this.commandId;
  }
}
