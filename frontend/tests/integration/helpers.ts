/**
 * SDK integration test helpers.
 * Connects YimsgClient to a real server via WebSocket.
 */
import WebSocket from 'ws';
import { YimsgClient } from '../../src/sdk/client';

const WS_URL = process.env.SERVER_WS_URL ?? 'wss://localhost:8080/ws';

let nameCounter = 0;
const runPrefix = `sdk_${Date.now()}`;

/** Generate a unique username for this test run. */
export function uniqueUser(prefix = 'u'): string {
  return `${runPrefix}_${prefix}_${++nameCounter}`;
}

/** Create a YimsgClient configured for integration testing. */
export function createClient(): YimsgClient {
  return new YimsgClient({
    wsUrl: WS_URL,
    requestTimeout: 10000,
    reconnectInterval: 500,
    wsFactory: (url: string) => new WebSocket(url, { rejectUnauthorized: false }) as unknown as globalThis.WebSocket,
  });
}

/** Wait for client to connect. */
export function waitConnected(client: YimsgClient): Promise<void> {
  return new Promise((resolve, reject) => {
    if (client.getSessionSnapshot().connectionState === 'connected') { resolve(); return; }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('connect timeout'));
    }, 5000);
    const onConnected = () => {
      clearTimeout(timeout);
      cleanup();
      resolve();
    };
    const onDisconnected = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error('disconnected before connected'));
    };
    const cleanup = () => {
      client.off('connection:connected', onConnected);
      client.off('connection:disconnected', onDisconnected);
    };

    client.on('connection:connected', onConnected);
    client.on('connection:disconnected', onDisconnected);
  });
}

/** Wait for a specific event to fire. */
export function waitEvent<K extends string>(
  client: YimsgClient,
  event: K,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`event ${event} timeout`)), timeoutMs);
    (client as any).once(event, (...args: unknown[]) => {
      clearTimeout(timeout);
      resolve(args.length === 1 ? args[0] : args);
    });
  });
}

/** Create a connected and registered+logged-in client. */
export async function createAuthenticatedClient(prefix = 'u'): Promise<{ client: YimsgClient; uid: string; username: string; token: string }> {
  const client = createClient();
  const username = uniqueUser(prefix);
  await client.register(username, 'pass123', username);
  const result = await client.login(username, 'pass123');

  return { client, uid: result.uid, username, token: result.token };
}

/** Clean up a client after test. */
export function destroyClient(client: YimsgClient): void {
  try { client.destroy(); } catch (_) {}
}

/** Delay helper. */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
