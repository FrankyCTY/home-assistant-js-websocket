import { Connection } from "./connection.js";
import * as messages from "./messages.js";
import {
  HassEntity,
  HassServices,
  HassConfig,
  HassUser,
  HassServiceTarget,
} from "./types.js";

// TODO: Short live command: Expect 1 "result" response from server.
export const getStates = (connection: Connection) =>
  connection.sendMessagePromise<HassEntity[]>(messages.states());

// TODO: Short live command: Expect 1 "result" response from server.
export const getServices = (connection: Connection) =>
  connection.sendMessagePromise<HassServices>(messages.services());

// TODO: Short live command: Expect 1 "result" response from server.
export const getConfig = (connection: Connection) =>
  connection.sendMessagePromise<HassConfig>(messages.config());

// TODO: Short live command: Expect 1 "result" response from server.
export const getUser = (connection: Connection) =>
  connection.sendMessagePromise<HassUser>(messages.user());

// TODO: Short live command: Expect 1 "result" response from server.
export const callService = (
  connection: Connection,
  domain: string,
  service: string,
  serviceData?: object,
  target?: HassServiceTarget,
  returnResponse?: boolean,
) =>
  connection.sendMessagePromise(
    messages.callService(domain, service, serviceData, target, returnResponse),
  );
