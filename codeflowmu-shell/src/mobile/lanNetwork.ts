export type LanNetworkInterface = {
  name: string;
  address: string;
  family: string;
};

/** Names commonly used by Docker, WSL, Hyper-V, VPN tunnels — not reachable from a phone on Wi-Fi. */
export function isVirtualNetworkInterface(name: string): boolean {
  const n = String(name || "").toLowerCase();
  return (
    n.includes("docker") ||
    n.includes("veth") ||
    n.startsWith("br-") ||
    n.includes("virbr") ||
    n.includes("vmnet") ||
    n.includes("vethernet") ||
    n.includes("wsl") ||
    n.includes("hyper-v") ||
    n.includes("hyperv") ||
    n.includes("loopback") ||
    n.includes("npcap") ||
    n.includes("tailscale") ||
    n.includes("zerotier") ||
    n.includes("hamachi") ||
    n.includes("tun") ||
    n.includes("tap") ||
    n.includes("virtualbox") ||
    n.includes("vmware")
  );
}

/** Default Docker bridge and common user-defined bridge subnets (not phone-reachable LAN). */
export function isDockerLikeIpv4(address: string): boolean {
  const m = /^(\d+)\.(\d+)\./.exec(String(address || "").trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 172 && b === 17) return true;
  if (a === 172 && b >= 18 && b <= 31) return true;
  return false;
}

export function isReachableLanInterface(iface: LanNetworkInterface): boolean {
  if (iface.family !== "IPv4") return false;
  if (isVirtualNetworkInterface(iface.name)) return false;
  if (isDockerLikeIpv4(iface.address)) return false;
  return true;
}

/** Lower score = preferred for LAN bind QR / links. */
export function lanIpv4PreferenceScore(address: string): number {
  const ip = String(address || "").trim();
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return 2;
  }
  return 9;
}

export function sortReachableLanInterfaces(
  interfaces: LanNetworkInterface[],
): LanNetworkInterface[] {
  return [...interfaces].sort((a, b) => {
    const pa = lanIpv4PreferenceScore(a.address);
    const pb = lanIpv4PreferenceScore(b.address);
    if (pa !== pb) return pa - pb;
    return a.address.localeCompare(b.address);
  });
}

export function filterReachableLanInterfaces(
  interfaces: LanNetworkInterface[],
): LanNetworkInterface[] {
  return sortReachableLanInterfaces(interfaces.filter(isReachableLanInterface));
}
