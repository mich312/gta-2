import crypto from 'node:crypto';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from 'shared';
import { Connection } from '../src/net/connection.js';

/**
 * The reconnect policy, against a real socket.
 *
 * The server answers a bad join with an `error` frame and then hangs up
 * (`server/src/host.ts`), so every rejection reaches the client as a close and
 * is indistinguishable from a dropped connection unless the code is read. A
 * `protocol` rejection retried is an endless 2-second loop — after a
 * `PROTOCOL_VERSION` bump, every tab left open across the deploy runs it at
 * once — while a `full` rejection retried is exactly right, because a slot may
 * free up.
 *
 * Driving the real `Connection` needs a real WebSocket peer, and the client
 * workspace has no server library. It only ever has to say one thing and hang
 * up, so the handshake and a single unmasked text frame are written by hand
 * rather than pulling `ws` in for eleven lines.
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** One `\x81 len payload` frame: fin + text, unmasked, payload under 126 bytes. */
function textFrame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

interface Rejector {
  port: number;
  /** ms since the server started, one entry per socket that completed a handshake. */
  opens: number[];
  stop: () => Promise<void>;
}

/** A server that rejects every connection with `code` and then closes. */
async function rejectingServer(code: string): Promise<Rejector> {
  const opens: number[] = [];
  const started = Date.now();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
    sock.once('data', (buf) => {
      const key = /sec-websocket-key: (.+)/i.exec(buf.toString('utf8'))?.[1]?.trim() ?? '';
      const accept = crypto
        .createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');
      sock.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      opens.push(Date.now() - started);
      sock.write(textFrame(JSON.stringify({ type: 'error', code, message: `rejected: ${code}` })));
      sock.write(Buffer.from([0x88, 0x00])); // close frame
      sock.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    opens,
    stop: () =>
      new Promise<void>((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
      }),
  };
}

const noStats = { addIn() {}, addOut() {} };

/** Long enough to have caught the 2000 ms reconnect, short enough to stay a test. */
const PAST_ONE_RETRY_MS = 2600;

let open: Connection[] = [];
let servers: Rejector[] = [];

afterEach(async () => {
  for (const c of open) c.close();
  open = [];
  for (const s of servers) await s.stop();
  servers = [];
});

async function connectAndWait(code: string): Promise<{ opens: number[]; errors: string[] }> {
  const server = await rejectingServer(code);
  servers.push(server);
  const errors: string[] = [];
  const conn = new Connection({
    url: `ws://127.0.0.1:${server.port}`,
    name: 'tester',
    stats: noStats as never,
    getResumeToken: () => null,
    onMessage: (msg: ServerMessage) => {
      if (msg.type === 'error') errors.push(msg.code);
    },
  });
  open.push(conn);
  conn.connect();
  await new Promise((r) => setTimeout(r, PAST_ONE_RETRY_MS));
  return { opens: server.opens, errors };
}

describe('reconnect policy', () => {
  it('stops after a protocol rejection', async () => {
    const { opens, errors } = await connectAndWait('protocol');
    expect(errors).toEqual(['protocol']);
    // One socket, not one every two seconds for ever.
    expect(opens.length).toBe(1);
  });

  it('keeps retrying a full server', async () => {
    const { opens, errors } = await connectAndWait('full');
    // A slot may free up, so this one is worth coming back for.
    expect(opens.length).toBeGreaterThan(1);
    expect(errors.length).toBe(opens.length);
    expect(new Set(errors)).toEqual(new Set(['full']));
  });
});
