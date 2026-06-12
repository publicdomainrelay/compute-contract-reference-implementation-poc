import { WATCHED_NSIDS } from './graph.js';

const JETSTREAM_URL = 'wss://jetstream2.us-east.bsky.network/subscribe';

export interface JetstreamCallbacks {
  onFrame(frame: unknown): void;
  onStatusChange(status: string, cls: string): void;
  onClose(event: CloseEvent): void;
}

export class JetstreamClient {
  private socket: WebSocket | undefined;

  constructor(private readonly callbacks: JetstreamCallbacks) {}

  connect(): void {
    const url = new URL(JETSTREAM_URL);
    for (const nsid of WATCHED_NSIDS) url.searchParams.append('wantedCollections', nsid);
    this.callbacks.onStatusChange('● connecting…', '');
    let socket: WebSocket;
    try {
      socket = new WebSocket(url.toString());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onStatusChange(`● failed: ${msg}`, 'disconnected');
      setTimeout(() => this.connect(), 5000);
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.callbacks.onStatusChange('● live', 'connected');
    socket.onmessage = (event) => {
      let frame: unknown;
      try { frame = JSON.parse(event.data as string); } catch { return; }
      this.callbacks.onFrame(frame);
    };
    socket.onerror = () => this.callbacks.onStatusChange('● stream error', 'disconnected');
    socket.onclose = (event) => {
      this.socket = undefined;
      this.callbacks.onStatusChange(`● disconnected (code ${event.code})`, 'disconnected');
      this.callbacks.onClose(event);
    };
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}
