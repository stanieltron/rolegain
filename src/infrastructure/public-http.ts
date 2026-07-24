import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Reject non-HTTP and local/private destinations before any network request. */
export async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Only HTTP and HTTPS sources are supported");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local"))
    throw new Error("Local network URLs are not allowed");
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  )
    throw new Error("Private network URLs are not allowed");
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:")
  )
    return true;
  const normalized = value.startsWith("::ffff:") ? value.slice(7) : value;
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some(Number.isNaN)) return false;
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    octets[0] === 0 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}
