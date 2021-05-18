export interface RyobiGDODevice {
  id: string;
  name: string;
  description: string;
  model: string;
  moduleId?: number;
  obstructed?: boolean;
  portId?: number;
  state?: number;
  stateAsOf?: number;
  type: 'hub' | 'gdo';
}
