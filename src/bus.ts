import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(200);

export interface BusEvent {
  type: 'traces' | 'signals' | 'scores' | 'experiment';
  ids: string[];
}

export function emit(ev: BusEvent): void {
  bus.emit('event', ev);
}
