import { describe, expect, test } from "bun:test";
import {
  assertServerReleaseContract,
  parseReleaseCandidate,
  releaseCandidateSha256,
  type ReleaseCandidate,
} from "../tools/release-candidate";

const serverContract = () => ({
  schemaVersion: 2,
  serverVersion: "0.5.0",
  database: { supportedSourceSchemas: [4, 5], destinationSchema: 6 },
  rollback: {
    previousPublishedTag: "v0.2.5",
    previousPublishedSchema: 4,
    directRollbackTag: null,
    directRollbackSupported: false,
  },
  clientToolingRevision: "a".repeat(40),
  qualifiedRenderers: [
    { version: "1.12.7", baselineSha256: "b".repeat(64) },
    { version: "1.13.4", baselineSha256: "c".repeat(64) },
  ],
});

const patchServerContract = () => ({
  ...serverContract(),
  schemaVersion: 3,
  serverVersion: "0.5.1",
  rollback: {
    previousPublishedTag: "v0.5.0",
    previousPublishedSchema: 6,
    directRollbackTag: "v0.5.0",
    directRollbackSupported: true,
  },
});

const candidate = (): ReleaseCandidate => ({
  schemaVersion: 1,
  createdAt: "2026-08-02T12:00:00.000Z",
  client: {
    version: "0.2.0",
    revision: "a".repeat(40),
    toolingSourceSha256: "b".repeat(64),
  },
  server: {
    version: "0.4.0",
    revision: "c".repeat(40),
    releaseContractSha256: "d".repeat(64),
  },
  endpoints: {
    controlOrigin: "https://blackglass.example.com",
    dataHost: "blackglass-data.example.com",
  },
  renderers: [
    {
      version: "1.12.7",
      baselineSha256: "e".repeat(64),
      officialDmgSha256: "f".repeat(64),
    },
    {
      version: "1.13.4",
      baselineSha256: "1".repeat(64),
      officialDmgSha256: "2".repeat(64),
    },
  ],
});

describe("immutable release candidates", () => {
  test("accepts the exact server migration and rollback contract", () => {
    expect(() => assertServerReleaseContract(serverContract())).not.toThrow();
    expect(() => assertServerReleaseContract(patchServerContract())).not.toThrow();
  });

  test("accepts same-schema patch rollback only to the exact predecessor", () => {
    for (const mutate of [
      (value: any) => { value.schemaVersion = 2; },
      (value: any) => { value.rollback.directRollbackSupported = false; },
      (value: any) => { value.rollback.directRollbackTag = null; },
      (value: any) => { value.rollback.directRollbackTag = "v0.4.9"; },
      (value: any) => { value.rollback.previousPublishedSchema = 7; },
    ]) {
      const value = patchServerContract();
      mutate(value);
      expect(() => assertServerReleaseContract(value)).toThrow();
    }
  });

  test("rejects unsafe or ambiguous server migration and rollback contracts", () => {
    const mutations: Array<(value: any) => void> = [
      (value) => { value.schemaVersion = 1; },
      (value) => { value.database.supportedSourceSchemas = []; },
      (value) => { value.database.supportedSourceSchemas = [4, 4]; },
      (value) => { value.database.supportedSourceSchemas = [4, 6]; },
      (value) => { value.rollback.previousPublishedSchema = 3; },
      (value) => { value.rollback.previousPublishedTag = "0.2.5"; },
      (value) => { value.rollback.directRollbackSupported = true; },
      (value) => { value.rollback.directRollbackTag = "v0.4.5"; },
    ];
    for (const mutate of mutations) {
      const value = serverContract();
      mutate(value);
      expect(() => assertServerReleaseContract(value)).toThrow();
    }
  });

  test("parses and hashes a complete cross-repository freeze", () => {
    const value = candidate();
    expect(parseReleaseCandidate(Buffer.from(JSON.stringify(value)))).toEqual(value);
    expect(releaseCandidateSha256(value)).toMatch(/^[a-f0-9]{64}$/);
    expect(releaseCandidateSha256(value)).toBe(releaseCandidateSha256(candidate()));
  });

  test("rejects source, endpoint, and renderer ambiguity", () => {
    const mutations: Array<(value: any) => void> = [
      (value) => { value.client.revision = "A".repeat(40); },
      (value) => { value.server.releaseContractSha256 = "short"; },
      (value) => { value.endpoints.controlOrigin = "http://BLACKGLASS.example.com"; },
      (value) => { value.renderers.push({ ...value.renderers[0] }); },
      (value) => { value.renderers[0].officialDmgSha256 = "0"; },
    ];
    for (const mutate of mutations) {
      const value: any = candidate();
      mutate(value);
      expect(() => parseReleaseCandidate(Buffer.from(JSON.stringify(value)))).toThrow();
    }
  });

  test("binds the candidate hash to both repositories and endpoints", () => {
    const baseline = candidate();
    for (const mutate of [
      (value: ReleaseCandidate) => { value.client.revision = "3".repeat(40); },
      (value: ReleaseCandidate) => { value.server.revision = "4".repeat(40); },
      (value: ReleaseCandidate) => { value.endpoints.dataHost = "other.example.com"; },
    ]) {
      const changed = candidate();
      mutate(changed);
      expect(releaseCandidateSha256(changed)).not.toBe(
        releaseCandidateSha256(baseline),
      );
    }
  });
});
