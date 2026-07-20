import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filterReachableLanInterfaces,
  isDockerLikeIpv4,
  isReachableLanInterface,
  isVirtualNetworkInterface,
  lanIpv4PreferenceScore,
} from "../mobile/lanNetwork.ts";

test("isVirtualNetworkInterface flags docker and wsl adapters", () => {
  assert.equal(isVirtualNetworkInterface("vEthernet (WSL)"), true);
  assert.equal(isVirtualNetworkInterface("DockerNAT"), true);
  assert.equal(isVirtualNetworkInterface("br-abc123"), true);
  assert.equal(isVirtualNetworkInterface("Wi-Fi"), false);
  assert.equal(isVirtualNetworkInterface("以太网"), false);
});

test("isDockerLikeIpv4 excludes docker bridge ranges", () => {
  assert.equal(isDockerLikeIpv4("172.19.0.1"), true);
  assert.equal(isDockerLikeIpv4("172.17.0.1"), true);
  assert.equal(isDockerLikeIpv4("172.16.15.109"), false);
  assert.equal(isDockerLikeIpv4("192.168.1.5"), false);
});

test("filterReachableLanInterfaces prefers real LAN over docker", () => {
  const out = filterReachableLanInterfaces([
    { name: "vEthernet (Default Switch)", address: "172.19.0.1", family: "IPv4" },
    { name: "Wi-Fi", address: "172.16.15.109", family: "IPv4" },
    { name: "Wi-Fi", address: "192.168.0.12", family: "IPv4" },
  ]);
  assert.deepEqual(
    out.map((i) => i.address),
    ["192.168.0.12", "172.16.15.109"],
  );
});

test("lanIpv4PreferenceScore orders common home LAN first", () => {
  assert.ok(lanIpv4PreferenceScore("192.168.1.1") < lanIpv4PreferenceScore("10.0.0.1"));
  assert.ok(lanIpv4PreferenceScore("10.0.0.1") < lanIpv4PreferenceScore("172.16.15.109"));
});

test("isReachableLanInterface combines name and address heuristics", () => {
  assert.equal(
    isReachableLanInterface({ name: "Wi-Fi", address: "172.16.15.109", family: "IPv4" }),
    true,
  );
  assert.equal(
    isReachableLanInterface({
      name: "vEthernet (WSL)",
      address: "172.19.0.1",
      family: "IPv4",
    }),
    false,
  );
});
