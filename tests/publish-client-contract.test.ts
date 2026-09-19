import { expect, test } from "bun:test";
import { inspectPublishClientSource } from "../tools/publish-client-contract";

const source = [
  'function a(e){return x("/publish/create",{token:e})}',
  'function b(e,t){return x("/publish/delete",{token:e,site_uid:t})}',
  'function c(e,t,n){return x("/publish/share/invite",{token:e,site_uid:t,email:n})}',
  'function d(e,t,n){return x("/publish/share/remove",{token:e,site_uid:t,share_uid:n})}',
  'x("/publish/share/accept",{token:e,code:r})',
  'x("/publish/list",{token:e})',
  'x("/publish/share/list",{token:e,site_uid:t})',
  'x("/api/site",{token:e,slug:t})',
  'x("/api/slug",{token:e,id:t,host:n,slug:i})',
  'x("/api/slugs",{token:e,ids:t})',
  'x("/api/customurl",{token:e,id:t,host:n,url:i,redirect:r})',
  'x(t,"/api/list",{token:e,id:n,version:2})',
  'x(t,"/api/options",{token:e,id:n,options:i})',
  'x(t,"/api/password",{token:e,id:n})',
  'x(t,"/api/password",{token:e,id:n,name:i,pw:r})',
  'x(t,"/api/password",{token:e,id:n,del:i})',
  'x(t,"/api/remove",{token:e,id:n,path:i})',
  '"/api/upload";headers:{"obs-token":e,"obs-id":n,"obs-path":encodeURIComponent(i),"obs-hash":r,"Content-Type":"application/octet-stream"},body:o',
  '"/api/download";body:JSON.stringify({token:e,id:n,path:i}),headers:{"Content-Type":"application/json"}',
  'e.stat.size>52428800',
  'e.startsWith("127.0.0.1")||e.startsWith("localhost")?"http://"+e:"https://"+e',
  't.startsWith("127.0.0.1")||t.startsWith("localhost")?"http://"+t:"https://"+t',
].join(";");

test("derives a source-bound clean-room Publish client contract", () => {
  const contract = inspectPublishClientSource(source, "1.13.4", "a".repeat(64));
  expect(contract.anchors).toHaveLength(22);
  expect(contract.routes["/api/password"]).toBe(3);
  expect(contract.requestContract.uploadHeaders).toEqual([
    "obs-token",
    "obs-id",
    "obs-path",
    "obs-hash",
    "Content-Type",
  ]);
  expect(contract.responseContract["/publish/create"]).toEqual(["id", "host"]);
});

test("fails closed when the native upload contract changes", () => {
  expect(() =>
    inspectPublishClientSource(
      source.replace('"obs-hash":r,', ""),
      "1.13.4",
      "a".repeat(64),
    )
  ).toThrow("site-upload-wire-contract");
});
