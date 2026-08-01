import { request as requestHttp } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import { connect as connectTcp, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { readVerifiedE2ETls } from "./e2e-tls";

const [rootArgument, ...extraArguments] = process.argv.slice(2);
if (!rootArgument || extraArguments.length !== 0) usage();

const tls = await readVerifiedE2ETls(rootArgument);
const { network } = tls.run.manifest;
const upgradedDownstreamSockets = new Set<Duplex>();
const upgradedUpstreamSockets = new Set<Socket>();

const server = createHttpsServer(
  {
    cert: tls.certificateBytes,
    key: tls.privateKeyBytes,
    minVersion: "TLSv1.2",
  },
  (request, response) => {
    if (requestAuthority(request.rawHeaders) !== network.control.authority.toLowerCase()) {
      response.writeHead(421, { "content-type": "text/plain", connection: "close" });
      response.end("Unknown E2E control host\n");
      return;
    }
    const upstream = requestHttp({
      host: network.control.upstreamHost,
      port: network.control.upstreamPort,
      method: request.method,
      path: request.url,
      headers: {
        ...request.headers,
        host: `${network.control.upstreamHost}:${network.control.upstreamPort}`,
      },
    });
    upstream.on("response", (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain", connection: "close" });
      }
      response.end(`E2E upstream failure: ${error.message}\n`);
    });
    request.pipe(upstream);
  },
);

server.on("upgrade", (request, socket, head) => {
  if (requestAuthority(request.rawHeaders) !== network.data.authority.toLowerCase()) {
    socket.end("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = connectTcp({
    host: network.data.upstreamHost,
    port: network.data.upstreamPort,
  });
  upgradedDownstreamSockets.add(socket);
  upgradedUpstreamSockets.add(upstream);
  const release = () => {
    upgradedDownstreamSockets.delete(socket);
    upgradedUpstreamSockets.delete(upstream);
  };
  socket.once("close", release);
  upstream.once("close", release);
  upstream.once("connect", () => {
    if (socket.destroyed) {
      upstream.destroy();
      return;
    }
    const headers: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (!name || value === undefined) continue;
      if (name.toLowerCase() === "host") {
        headers.push(`Host: ${network.data.upstreamHost}:${network.data.upstreamPort}`);
      } else {
        headers.push(`${name}: ${value}`);
      }
    }
    upstream.write(
      `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n` +
        `${headers.join("\r\n")}\r\n\r\n`,
    );
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.on("tlsClientError", () => {
  // Chromium may abandon speculative TLS connections. This is not a proxy failure.
});

server.listen(network.tlsProxy.listenPort, network.tlsProxy.listenHost, () => {
  console.log(JSON.stringify({
    ready: true,
    runManifestSha256: tls.run.manifestSha256,
    tlsMetadataSha256: tls.metadataSha256,
    address: network.tlsProxy.listenHost,
    port: network.tlsProxy.listenPort,
    control: network.control,
    data: network.data,
  }));
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(server));
}

function requestAuthority(rawHeaders: string[]): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "host" && rawHeaders[index + 1]) {
      values.push(rawHeaders[index + 1] as string);
    }
  }
  if (values.length !== 1 || values[0] !== values[0]?.trim()) return undefined;
  return values[0]?.toLowerCase();
}

function shutdown(proxy: Server): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const socket of upgradedDownstreamSockets) socket.destroy();
  for (const socket of upgradedUpstreamSockets) socket.destroy();
  proxy.closeAllConnections();
  proxy.close((error) => process.exit(error ? 1 : 0));
}

function usage(): never {
  console.error("Usage: bun run e2e:tls:proxy -- <prepared-E2E-run-directory>");
  process.exit(2);
}
