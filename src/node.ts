import { WebSocket, WebSocketServer } from 'ws';
import crypto from 'crypto';

export class MessagingNode {
  private server: WebSocketServer;
  private peers: Set<WebSocket> = new Set();
  private seenHashes = new Set<string>();

  constructor(private port: number, peerAddresses: string[] = []) {
    this.server = new WebSocketServer({ port });
    this.server.on('connection', (ws) => {
      this.setupPeer(ws);
    });

    for (const address of peerAddresses) {
      this.connectToPeer(address);
    }
  }

  private connectToPeer(address: string) {
    const ws = new WebSocket(address);
    ws.on('open', () => {
      this.setupPeer(ws);
    });
    ws.on('error', (err) => {
      console.error(`Failed to connect to ${address}: ${err.message}`);
    });
  }

  private setupPeer(ws: WebSocket) {
    ws.on('message', (data) => {
      this.processMessage(data.toString());
    });
    ws.on('close', () => {
      this.peers.delete(ws);
    });
    ws.on('error', () => {
      this.peers.delete(ws);
    });
    this.peers.add(ws);
  }

  private processMessage(message: string) {
    const hash = crypto.createHash('sha256').update(message).digest('hex');
    if (this.seenHashes.has(hash)) return;

    this.seenHashes.add(hash);
    // Broadcast to others if we haven't seen it yet
    this.broadcastInternal(message);
  }

  async broadcast(msg: string): Promise<boolean> {
    const hash = crypto.createHash('sha256').update(msg).digest('hex');
    this.seenHashes.add(hash);
    this.broadcastInternal(msg);
    return true;
  }

  private broadcastInternal(msg: string) {
    for (const peer of this.peers) {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(msg);
      }
    }
  }

  close() {
    this.server.close();
    for (const peer of this.peers) {
      peer.close();
    }
  }
}
