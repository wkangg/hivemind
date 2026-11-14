// Serves a fetch-style handler over node:http, which both Node and Bun provide.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (req: Request) => Response | Promise<Response>;

/** Pass port 0 to let the system pick a free one. */
export function serve(handler: Handler, port: number, hostname = "127.0.0.1") {
  const server = createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        for (const v of [value ?? []].flat()) headers.append(name, v);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const response = await handler(
        new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method,
          headers,
          body: hasBody ? Buffer.concat(chunks) : undefined,
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error(e);
      res.writeHead(500).end();
    }
  });
  return new Promise<{ url: string; stop(): void }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () =>
      resolve({
        url: `http://${hostname}:${(server.address() as AddressInfo).port}`,
        stop: () => {
          server.close();
          server.closeAllConnections();
        },
      }),
    );
  });
}
