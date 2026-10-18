import net from 'node:net';

export const DEFAULT_PORT = 4317;
/** Ports tried, in order, when the configured port is taken by another program. */
export const FALLBACK_PORTS: number[] = Array.from({ length: 13 }, (_, i) => 4318 + i);

/** True if nothing listens on the loopback port and we could bind it. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** Picks the first port from `candidates` for which `isFree` holds, or null. */
export async function pickPort(candidates: number[], isFree: (port: number) => Promise<boolean> = isPortFree): Promise<number | null> {
  for (const p of candidates) if (await isFree(p)) return p;
  return null;
}

/** An OS-assigned free port (used by tests). */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}
