import { Store, createStore } from "./store.js";
import { Connection } from "./connection.js";
import { UnsubscribeFunc } from "./types.js";

export type Collection<State> = {
  state: State;
  refresh(): Promise<void>;
  subscribe(subscriber: (state: State) => void): UnsubscribeFunc;
};

// Time to wait to unsubscribe from updates after last subscriber unsubscribes
const UNSUB_GRACE_PERIOD = 5000; // 5 seconds
const DEBUG = false;

/**
 *
 * @param conn connection
 * @param key the key to store it on the connection. Must be unique for each collection.
 * @param fetchCollection fetch the current state. If undefined assumes subscribeUpdates receives current state
 * @param subscribeUpdates subscribe to updates on the current state
 * @returns
 */
// TODO: Collection is an coordinator that glue connection & specific store state togther.
export const getCollection = <State>(
  conn: Connection,
  key: string,
  fetchCollection: ((conn: Connection) => Promise<State>) | undefined,
  subscribeUpdates?: (
    conn: Connection,
    store: Store<State>,
  ) => Promise<UnsubscribeFunc>,
  // TODO: If unsubGrace, when all subscribers are unsubscribed, we schedule a teardown of the subscription after a 5 seconds delay.
  options: { unsubGrace: boolean } = { unsubGrace: true },
): Collection<State> => {
  // TODO: We store the collection object on the connection object by key.
  // TODO: This collection obj will have reference to the store, and store level functions like refresh, subscribe.
  // @ts-ignore
  if (conn[key]) {
    // @ts-ignore
    return conn[key];
  }

  // TODO: Active subscriptions count.
  let activeSubscriptions = 0;
  let unsubProm: Promise<UnsubscribeFunc>;
  let unsubTimer: number | undefined;
  // TODO: Initialize store object undefined state for the collection (e.g. entities).
  let store = createStore<State>();

  // TODO: Refresh the collection store state.
  // TODO: This invokes consumer provided fetchCollection callback to populate the store state.
  const refresh = (): Promise<void> => {
    if (!fetchCollection) {
      throw new Error("Collection does not support refresh");
    }

    return fetchCollection(conn).then((state) => store.setState(state, true));
  };

  // TODO: Suppress errors if socket is connecting, closing or closed as refresh will be called again when we re-establish the connection (in connection ready event handler).
  const refreshSwallow = () =>
    refresh().catch((err: unknown) => {
      // Swallow errors if socket is connecting, closing or closed.
      // We will automatically call refresh again when we re-establish the connection.
      if (conn.connected) {
        throw err;
      }
    });

  // TODO: Set up INITIAL subscription to the store state.
  const setupUpdateSubscription = () => {
    // TODO: Clear unsub timer as we are setting up a new subscription to the store state.
    if (unsubTimer !== undefined) {
      if (DEBUG) {
        console.log(`Prevented unsubscribe for ${key}`);
      }
      clearTimeout(unsubTimer);
      unsubTimer = undefined;
      return;
    }

    if (DEBUG) {
      console.log(`Subscribing to ${key}`);
    }

    // TODO: Invoke the consumer provided callback that they want to be
    // notified when the FIRST store state subscription is set up.
    // TODO: Example: Entities would like to send subscribe_entities message to ws server to establish a subscription to entity state updates to backend.
    if (subscribeUpdates) {
      unsubProm = subscribeUpdates(conn, store);
    }

    // TODO: Refresh/repopulate/rehydrate the collection store state immediately.
    // TODO:: AND set up connection ready event handler to refresh the collection store state on "reconnetion".
    if (fetchCollection) {
      // Fetch when connection re-established.
      conn.addEventListener("ready", refreshSwallow);
      refreshSwallow();
    }

    conn.addEventListener("disconnected", handleDisconnect);
  };

  // TODO: TEARDOWN: Remove connection event listeners and clear the store state e.g.
  const teardownUpdateSubscription = () => {
    if (DEBUG) {
      console.log(`Unsubscribing from ${key}`);
    }
    unsubTimer = undefined;

    // Unsubscribe from changes
    if (unsubProm)
      unsubProm.then((unsub) => {
        unsub();
      });
    // TODO: Clear the collection store state.
    store.clearState();
    // TODO: Remove connection event listeners.
    conn.removeEventListener("ready", refresh);
    conn.removeEventListener("disconnected", handleDisconnect);
  };

  // TODO: Delay for 5 seconds before teardown the subscription.
  const scheduleTeardownUpdateSubscription = () => {
    if (DEBUG) {
      console.log(`Scheduling unsubscribing from ${key}`);
    }
    unsubTimer = setTimeout(teardownUpdateSubscription, UNSUB_GRACE_PERIOD);
  };

  // TODO: Handle socket disconnection event.
  const handleDisconnect = () => {
    // TODO: Good time to execute the scheduled teardown of the subscription when socket is disconnected.
    // If we're going to unsubscribe and then lose connection,
    // just unsubscribe immediately.
    if (unsubTimer) {
      clearTimeout(unsubTimer);
      teardownUpdateSubscription();
    }
  };

  // @ts-ignore
  // TODO: Define collection obj
  conn[key] = {
    // TODO: Return the current collection store state.
    get state() {
      return store.state;
    },

    // TODO: Refresh the collection store state.
    // TODO: This invokes consumer provided fetchCollection callback to populate the store state.
    refresh,

    // TODO: For consumer to subscribe to the collection state changes.
    subscribe(subscriber: (state: State) => void): UnsubscribeFunc {
      activeSubscriptions++;

      if (DEBUG) {
        console.log(
          `New subscriber for ${key}. Active subscribers: ${activeSubscriptions}`,
        );
      }

      // If this was the first subscriber, attach collection
      if (activeSubscriptions === 1) {
        setupUpdateSubscription();
      }

      // TODO: Subscribe to the store state changes.
      const unsub = store.subscribe(subscriber);

      if (store.state !== undefined) {
        // Don't call it right away so that caller has time
        // to initialize all the things.
        setTimeout(() => subscriber(store.state!), 0);
      }

      // TODO: Unsubscribe function.
      // TODO: Unsube from collection state changes
      // TODO: If there are no more subscribers, perform teardown of the subscription.
      return () => {
        // TODO: Unsubscribe from store state changes.
        unsub();
        activeSubscriptions--;

        if (DEBUG) {
          console.log(
            `Unsubscribe for ${key}. Active subscribers: ${activeSubscriptions}`,
          );
        }

        // TODO: If there are no more subscribers, perform teardown of the subscription.
        if (!activeSubscriptions) {
          options.unsubGrace
            ? scheduleTeardownUpdateSubscription()
            : teardownUpdateSubscription();
        }
      };
    },
  };

  // @ts-ignore
  return conn[key];
};

// Legacy name. It gets a collection and subscribes.
export const createCollection = <State>(
  key: string,
  fetchCollection: (conn: Connection) => Promise<State>,
  subscribeUpdates:
    | ((conn: Connection, store: Store<State>) => Promise<UnsubscribeFunc>)
    | undefined,
  conn: Connection,
  onChange: (state: State) => void,
): UnsubscribeFunc =>
  getCollection(conn, key, fetchCollection, subscribeUpdates).subscribe(
    onChange,
  );
