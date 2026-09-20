import { describe, expect, it } from "vitest";

import { wallboardNetworkAddresses } from "../src/server/routes/wallboard";

function ipv4(address: string, internal = false): { address: string; netmask: string; family: "IPv4"; mac: string; internal: boolean; cidr: string } {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

describe("wallboard network addresses", () => {
  it("prioritizes Tailscale addresses and preserves LAN addresses", () => {
    const addresses = wallboardNetworkAddresses({
      Ethernet: [ipv4("192.168.1.20")],
      Tailscale: [ipv4("100.101.102.103")],
      "vEthernet (Default Switch)": [ipv4("172.20.0.1")],
    });

    expect(addresses).toEqual([
      { address: "100.101.102.103", network: "tailscale" },
      { address: "192.168.1.20", network: "lan" },
    ]);
  });

  it("falls back to LAN addresses when Tailscale is unavailable", () => {
    expect(wallboardNetworkAddresses({
      Ethernet: [ipv4("192.168.1.20")],
      WiFi: [ipv4("10.0.0.8")],
    })).toEqual([
      { address: "192.168.1.20", network: "lan" },
      { address: "10.0.0.8", network: "lan" },
    ]);
  });

  it("does not treat non-Tailscale CGNAT addresses as remote links", () => {
    expect(wallboardNetworkAddresses({
      Ethernet: [ipv4("100.101.102.103")],
    })).toEqual([]);
  });
});
