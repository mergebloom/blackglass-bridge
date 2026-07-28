import { describe, expect, test } from "bun:test";
import {
  assertE2ENetworkPlan,
  deriveE2ENetworkPlan,
} from "../tools/e2e-network";

describe("prepared E2E network plan", () => {
  const endpoints = {
    controlOrigin: "https://blackglass.example.com",
    dataHost: "blackglass-data.example.com",
  };

  test("derives public authorities, loopback routes, and Chromium rules", () => {
    expect(deriveE2ENetworkPlan(endpoints)).toEqual({
      schemaVersion: 1,
      control: {
        publicOrigin: endpoints.controlOrigin,
        hostname: "blackglass.example.com",
        authority: "blackglass.example.com",
        upstreamHost: "127.0.0.1",
        upstreamPort: 3000,
      },
      data: {
        publicHost: endpoints.dataHost,
        hostname: "blackglass-data.example.com",
        authority: "blackglass-data.example.com",
        upstreamHost: "127.0.0.1",
        upstreamPort: 3003,
      },
      tlsProxy: {
        listenHost: "127.0.0.1",
        listenPort: 8443,
        chromiumHostResolverRules:
          "MAP blackglass-data.example.com 127.0.0.1:8443,MAP blackglass.example.com 127.0.0.1:8443",
      },
    });
  });

  test("rejects tampered routes and non-TLS public control endpoints", () => {
    const changed = structuredClone(deriveE2ENetworkPlan(endpoints));
    changed.data.upstreamPort = 3004 as 3003;
    expect(() => assertE2ENetworkPlan(changed, endpoints)).toThrow("not derived");
    expect(() =>
      deriveE2ENetworkPlan({
        controlOrigin: "http://127.0.0.1:3000",
        dataHost: "127.0.0.1:3003",
      }),
    ).toThrow("HTTPS");
  });
});
