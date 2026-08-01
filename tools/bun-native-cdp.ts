import type {
  Browser,
  BrowserType,
  ConnectOverCDPTransport,
} from "#release-playwright-core";

const DISCOVERY_TIMEOUT_MS = 2_000;
const SOCKET_OPEN_TIMEOUT_MS = 5_000;
const PLAYWRIGHT_CONNECT_TIMEOUT_MS = 30_000;

export async function connectOverBunNativeCDP(
  browserType: BrowserType,
  port: number,
): Promise<Browser> {
  assertLoopbackPort(port);
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    redirect: "error",
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Electron CDP discovery failed: ${response.status}`);
  }
  const discovery = await response.json() as { webSocketDebuggerUrl?: unknown };
  const endpoint = validatedBrowserEndpoint(discovery.webSocketDebuggerUrl, port);
  const socket = new WebSocket(endpoint);
  await waitForOpen(socket);

  const transport: ConnectOverCDPTransport = {
    send(message): void {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Electron CDP transport is not open");
      }
      socket.send(JSON.stringify(message));
    },
    close(): void {
      if (
        socket.readyState === WebSocket.CONNECTING ||
        socket.readyState === WebSocket.OPEN
      ) {
        socket.close();
      }
    },
  };
  socket.addEventListener("message", (event) => {
    let message: object;
    try {
      message = JSON.parse(String(event.data)) as object;
    } catch {
      transport.onclose?.("Electron CDP returned malformed JSON");
      socket.close();
      return;
    }
    transport.onmessage?.(message);
  });
  socket.addEventListener("close", (event) => {
    transport.onclose?.(event.reason || undefined);
  }, { once: true });
  socket.addEventListener("error", () => {
    transport.onclose?.("Electron CDP WebSocket failed");
  }, { once: true });

  try {
    return await browserType.connectOverCDP(transport, {
      timeout: PLAYWRIGHT_CONNECT_TIMEOUT_MS,
    });
  } catch (error) {
    transport.close();
    throw error;
  }
}

function assertLoopbackPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Electron CDP port must be an integer from 1 to 65535");
  }
}

function validatedBrowserEndpoint(value: unknown, port: number): string {
  if (typeof value !== "string") {
    throw new Error("Electron CDP discovery returned no browser WebSocket URL");
  }
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port !== String(port) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    !/^\/devtools\/browser\/[^/]+$/u.test(endpoint.pathname)
  ) {
    throw new Error("Electron CDP discovery returned an unsafe browser WebSocket URL");
  }
  return endpoint.href;
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolveOpen, rejectOpen) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      if (error) {
        if (
          socket.readyState === WebSocket.CONNECTING ||
          socket.readyState === WebSocket.OPEN
        ) {
          socket.close();
        }
        rejectOpen(error);
      } else {
        resolveOpen();
      }
    };
    const handleOpen = () => settle();
    const handleError = () => settle(new Error("Failed to open the Electron CDP WebSocket"));
    const timer = setTimeout(() => {
      settle(new Error("Timed out opening the Electron CDP WebSocket"));
    }, SOCKET_OPEN_TIMEOUT_MS);
    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
  });
}
