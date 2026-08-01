import { expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type {
  Browser,
  BrowserType,
  ConnectOverCDPTransport,
} from "#release-playwright-core";
import { connectOverBunNativeCDP } from "../tools/bun-native-cdp";

test("connectOverBunNativeCDP adapts Bun's native WebSocket to Playwright", async () => {
  const receivedByServer: Array<object> = [];
  const port = await availableLoopbackPort();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, currentServer) {
      const url = new URL(request.url);
      if (url.pathname === "/json/version") {
        return Response.json({
          webSocketDebuggerUrl:
            `ws://127.0.0.1:${currentServer.port}/devtools/browser/test-browser`,
        });
      }
      if (
        url.pathname === "/devtools/browser/test-browser" &&
        currentServer.upgrade(request)
      ) {
        return;
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      message(socket, rawMessage) {
        const message = JSON.parse(String(rawMessage)) as object;
        receivedByServer.push(message);
        socket.send(JSON.stringify({ id: 7, result: { attached: true } }));
      },
    },
  });
  const fakeBrowser = { marker: "browser" } as unknown as Browser;
  let receivedByTransport: object | undefined;
  let observedTimeout: number | undefined;
  const browserType = {
    async connectOverCDP(
      transport: ConnectOverCDPTransport,
      options?: { timeout?: number },
    ): Promise<Browser> {
      observedTimeout = options?.timeout;
      const response = new Promise<object>((resolve) => {
        transport.onmessage = resolve;
      });
      transport.send({ id: 7, method: "Target.getTargets" });
      receivedByTransport = await response;
      transport.close();
      return fakeBrowser;
    },
  } as unknown as BrowserType;

  try {
    const browser = await connectOverBunNativeCDP(browserType, port);
    expect(browser).toBe(fakeBrowser);
    expect(observedTimeout).toBe(30_000);
    expect(receivedByServer).toEqual([{ id: 7, method: "Target.getTargets" }]);
    expect(receivedByTransport).toEqual({ id: 7, result: { attached: true } });
  } finally {
    server.stop(true);
  }
});

test("connectOverBunNativeCDP rejects a non-loopback browser endpoint", async () => {
  const port = await availableLoopbackPort();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch() {
      return Response.json({
        webSocketDebuggerUrl: "ws://example.com/devtools/browser/untrusted",
      });
    },
  });

  try {
    await expect(
      connectOverBunNativeCDP({} as BrowserType, port),
    ).rejects.toThrow("unsafe browser WebSocket URL");
  } finally {
    server.stop(true);
  }
});

test("connectOverBunNativeCDP closes a rejected WebSocket upgrade", async () => {
  const port = await availableLoopbackPort();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/json/version") {
        return Response.json({
          webSocketDebuggerUrl:
            `ws://127.0.0.1:${port}/devtools/browser/rejected-browser`,
        });
      }
      return new Response("Upgrade rejected", { status: 403 });
    },
  });

  try {
    await expect(
      connectOverBunNativeCDP({} as BrowserType, port),
    ).rejects.toThrow("Failed to open the Electron CDP WebSocket");
  } finally {
    server.stop(true);
  }
});

async function availableLoopbackPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}
