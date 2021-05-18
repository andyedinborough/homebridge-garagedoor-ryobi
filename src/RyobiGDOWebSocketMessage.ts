export interface RyobiWebSocketValue {
  value: number | boolean;
  lastValue: number | boolean;
  lastSet: number;
}
export interface RyobiGDOWebSocketMessage {
  method: string;
  params: {
    [key: string]: RyobiWebSocketValue | string;
  };
}
