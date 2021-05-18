import type { Logger } from 'homebridge';
import fetch, { RequestInit } from 'node-fetch';
import { UV_FS_O_FILEMAP } from 'node:constants';
import WebSocket from 'ws';
import { DeviceStatusResponse, GetDeviceResponse, LoginResponse } from './RyobiGDO';
import { RyobiGDOCredentials } from './RyobiGDOCredentials';
import { RyobiGDODevice } from './RyobiGDODevice';
import { RyobiGDOSession } from './RyobiGDOSession';
import { RyobiGDOWebSocketMessage, RyobiWebSocketValue } from './RyobiGDOWebSocketMessage';

const apikeyURL = 'https://tti.tiwiconnect.com/api/login';
const deviceURL = 'https://tti.tiwiconnect.com/api/devices';
const websocketURL = 'wss://tti.tiwiconnect.com/api/wsrpc';

type MessageHandler = (deviceId: string, module: string, name: string, data: RyobiWebSocketValue) => void;

export class RyobiGDOApi {
  private _websocket: WebSocket | undefined;
  private _pingTimer: NodeJS.Timer | undefined;
  private _reconnectTimer: NodeJS.Timer | undefined;
  private _websocketPromise: Promise<WebSocket> | undefined;
  private readonly _subscribed: Record<string, boolean> = {};
  private readonly _listeners = new Set<MessageHandler>();

  constructor(
    private readonly session: RyobiGDOSession,
    private readonly credentials: RyobiGDOCredentials,
    private readonly logger: Logger,
  ) {}

  public async openDoor(device: Partial<RyobiGDODevice>): Promise<void> {
    this.logger.debug('GARAGEDOOR openDoor');
    try {
      await this.sendWebsocketCommand(device, this.getDoorCommand(device, true));
    } catch (x) {
      this.logger.error(`Error sending openDoor command: ${x}`);
    }
  }

  public async closeDoor(device: Partial<RyobiGDODevice>): Promise<void> {
    this.logger.debug('GARAGEDOOR closeDoor');
    try {
      await this.sendWebsocketCommand(device, this.getDoorCommand(device, false));
    } catch (x) {
      this.logger.error(`Error sending closeDoor command: ${x}`);
    }
  }

  private getDoorCommand(device: Partial<RyobiGDODevice>, open: boolean) {
    return {
      jsonrpc: '2.0',
      method: 'gdoModuleCommand',
      params: {
        msgType: 16,
        moduleType: device.moduleId,
        portId: device.portId,
        moduleMsg: { doorCommand: open ? 1 : 0 },
        topic: device.id,
      },
    };
  }

  public async updateDevice(device: Partial<RyobiGDODevice>) {
    if (!device.id) {
      await this.getDeviceId(device);
    }

    const queryUri = deviceURL + '/' + device.id;
    await this.getApiKey();
    const values = await this.getJson<DeviceStatusResponse>(queryUri);

    if (!values?.result?.length) {
      throw new Error('Invalid response: ' + JSON.stringify(values, null, 2));
    }

    const map = values.result?.[0]?.deviceTypeMap;
    if (!map) {
      this.logger.error('deviceTypeMap not found');
      return;
    }
    const garageDoorModule = Object.values(map).find(
      (m) =>
        Array.isArray(m?.at?.moduleProfiles?.value) &&
        m?.at?.moduleProfiles?.value?.some((v) => typeof v === 'string' && v.indexOf('garageDoor_') === 0),
    );

    device.portId = toNumber(garageDoorModule?.at?.portId?.value);
    device.moduleId = toNumber(garageDoorModule?.at?.moduleId?.value);
    const at = values.result?.[0]?.deviceTypeMap?.['garageDoor_' + device.portId]?.at;
    device.state = toNumber(at?.doorState?.value);
    device.obstructed = toBool(at?.sensorFlag?.value);
    device.stateAsOf = Date.now();
  }

  private async request(url: string, init?: RequestInit) {
    const cookie = Object.keys(this.session.cookies)
      .map((key) => key + '=' + this.session.cookies[key])
      .join('; ');
    this.logger.debug('GET ' + url);

    const response = await fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        cookie,
      },
    });

    const cookies = response.headers.raw()['set-cookie'] ?? [];
    updateSessionFromCookies(this.session, cookies);
    return response;
  }

  private async getJson<T = unknown>(url: string, init?: RequestInit) {
    const response = await this.request(url, init);
    const text = await response.text();
    this.logger.debug(text);
    return JSON.parse(text) as T;
  }

  private async getApiKey() {
    this.logger.debug('getApiKey');
    if (this.session.apiKey && this.session.cookieExpires && this.session.cookieExpires > new Date()) {
      return this.session.apiKey;
    }

    const result = await this.getJson<LoginResponse>(apikeyURL, {
      method: 'post',
      body: `username=${encodeURIComponent(this.credentials.email)}&password=${encodeURIComponent(this.credentials.password)}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (typeof result.result === 'string' || !result.result?.auth?.apiKey) {
      throw new Error('Unauthorized -- check your ryobi username/password: ' + result.result);
    }

    this.session.apiKey = result.result.auth.apiKey;
    return this.session.apiKey;
  }

  public async getDevices(): Promise<RyobiGDODevice[]> {
    await this.getApiKey();
    const devices = await this.getDevicesRaw();
    return devices.map((device) => ({
      description: device.metaData?.description ?? '',
      name: device.metaData?.name ?? '',
      id: device.varName ?? '',
      model: device.deviceTypeIds?.[0] ?? '',
      type: /hub/i.test(device.deviceTypeIds?.[0] ?? '') ? 'hub' : 'gdo',
    }));
  }

  private async getDeviceId(device: Partial<RyobiGDODevice>) {
    if (device.id) {
      return;
    }
    this.logger.debug('getDeviceId');

    const devices = await this.getDevices();

    if (!device.id && device.name) {
      Object.assign(
        device,
        devices.find((x) => x.name === device.name),
      );
    } else {
      Object.assign(
        device,
        devices.find((x) => x.type !== 'hub'),
      );
    }

    this.logger.debug('device.id: ' + device.id);
  }

  private async getDevicesRaw() {
    const result = await this.getJson<GetDeviceResponse>(deviceURL);

    if (typeof result.result === 'string' || !Array.isArray(result.result)) {
      throw new Error('Unauthorized -- check your ryobi username/password: ' + result.result);
    }
    return result?.result;
  }

  public async subscribe(device: Partial<RyobiGDODevice>, listener: MessageHandler) {
    this._listeners.add(listener);

    if (!device.id) {
      this.logger.error('Cannot unsubscribe without a device id');
      return;
    }
    await this.unsubscribe(device);
    const cmd = { jsonrpc: '2.0', method: 'wskSubscribe', params: { topic: `${device.id}.wskAttributeUpdateNtfy` } };
    await this.sendWebsocketCommand(device, cmd);
    this._subscribed[device.id] = true;
  }

  private async unsubscribe(device: Partial<RyobiGDODevice>) {
    if (!device.id) {
      this.logger.error('Cannot unsubscribe without a device id');
      return;
    }
    if (!this._subscribed[device.id]) return;
    const cmd = { jsonrpc: '2.0', method: 'wskUnsubscribe', params: { topic: `${device.id}.wskAttributeUpdateNtfy` } };
    await this.sendWebsocketCommand(device, cmd);
    delete this._subscribed[device.id];
  }

  private async sendWebsocketCommand(device: Partial<RyobiGDODevice>, message: unknown) {
    if (!device.moduleId || !device.portId) {
      await this.updateDevice(device);
    }

    if (!device.moduleId) {
      throw new Error('doorModuleId is undefined');
    }
    if (!device.portId) {
      throw new Error('doorPortId is undefined');
    }

    const ws = await this.openWebSocket();

    const sendMessage = JSON.stringify(message, null, 2);
    this.logger.debug('sending websocket: ' + sendMessage);
    ws.send(sendMessage);
    this.logger.debug('sending ping');
    await this.ping(ws);

    this.logger.debug('command finished');
  }

  private async ping(ws: WebSocket) {
    const id = `ping:${Math.random()}`;
    return new Promise<void>((resolve, reject) => {
      let tmr = setTimeout(() => reject(), 30e3);
      const handlePong = (data: Buffer) => {
        if (data.toString() === id) {
          clearTimeout(tmr);
          ws.off('pong', handlePong);
          resolve();
        }
      };
      ws.on('pong', handlePong);
      ws.ping(id);
    });
  }

  private async closeWebSocket() {
    const { _websocket } = this;
    this._websocket = undefined;
    this._websocketPromise = undefined;
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
    }
    if (!_websocket) return;
    _websocket.close();
  }

  private async openWebSocket(): Promise<WebSocket> {
    if (this._websocket) return this._websocket;
    if (this._websocketPromise) return await this._websocketPromise;

    this.closeWebSocket();

    this._websocketPromise = new Promise<WebSocket>(async (resolve, reject) => {
      const apiKey = await this.getApiKey();
      const ws = new WebSocket(websocketURL);
      ws.on('open', () => {
        const login = JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'srvWebSocketAuth',
          params: { varName: this.credentials.email, apiKey },
        });
        this.logger.debug('sending api key');
        ws.send(login);
      });

      ws.on('message', (data) => {
        this.logger.debug('message received: ' + data);

        const returnObj = JSON.parse(data.toString());
        if (!this._websocket && returnObj?.result?.authorized) {
          this._websocket = ws;
          this._pingTimer = setInterval(() => ws.ping(), 30e3);
          this.logger.info('websocket connected');
          resolve(ws);
        } else if (this._websocket) {
          this.handleWebSocketMessage(data);
        }
      });

      ws.on('close', (code: number, reason: string) => {
        this.logger.debug('closing');
        if (this._websocket) {
          this.logger.error(`WebSocket closing unexpectedly: ${code} -- ${reason}`);
        } else {
          this.logger.error(`WebSocket could not fully open: ${code} -- ${reason}`);
          reject('WebSocket closed');
        }
        this.reopenWebSocket();
      });

      ws.on('error', (x) => {
        this.logger.error('WebSocket error: ' + x);
        if (!this._websocket) {
          reject(x);
        }
        this.reopenWebSocket();
      });
    });

    return await this._websocketPromise;
  }

  private reopenWebSocket() {
    this.closeWebSocket();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
    }
    this._reconnectTimer = setTimeout(() => this.openWebSocket(), 5e3);
  }

  private handleWebSocketMessage(data: unknown | undefined) {
    const message = data as RyobiGDOWebSocketMessage;
    if (message?.method !== 'wskAttributeUpdateNtfy') {
      this.logger.warn(`Unrecognized method: ${message.method}`);
      return;
    }

    const deviceId = message.params?.varName;
    if (typeof deviceId !== 'string') {
      this.logger.warn('Unrecognized varName', deviceId);
      return;
    }

    const listeners = Array.from(this._listeners);
    if (listeners.length === 0) {
      this.logger.warn('No listeners to trigger event');
      return;
    }

    const values = Object.entries(message.params);
    for (const [name, value] of values) {
      const [_, module, property] = name.match(/(\w+)\.(\w+)/) ?? [];
      if (!module || !property || typeof value === 'string') {
        if (name !== 'varName' && name !== 'topic') {
          this.logger.warn(`Invalid data: ${name}`, value);
        }
        continue;
      }

      for (const listener of listeners) {
        try {
          listener(deviceId, module, property, value);
        } catch (x) {
          this.logger.error(`Error triggering listener for ${module}.${property}`, value, x);
        }
      }
    }
  }
}

export function updateSessionFromCookies(session: RyobiGDOSession, cookies: string[]) {
  for (const cookie of cookies) {
    const expires = cookie.match(/expires\s*=\s*([^;]+)/i);
    if (expires) {
      session.cookieExpires = new Date(expires[1] ?? '');
    }
    const match = cookie.match(/([^=]+)=([^;]+)/);
    if (match) {
      session.cookies[match[1]] = match[2];
    }
  }
}

function toNumber(value: unknown) {
  return typeof value === 'number' ? value : undefined;
}

function toBool(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}
