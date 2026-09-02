/**
 * Who is on the other end of a socket.
 *
 * Resolved once at the edge by the auth slice, then carried into the shard as
 * signed connect metadata — the Durable Object never re-validates a JWT.
 */

export interface Identity {
  userId: string;
  name: string;
  roles: string[];
  /** Epoch seconds at which the underlying credential expires. */
  expiresAt: number;
}

export const ANONYMOUS: Identity = {
  userId: "anonymous",
  name: "anonymous",
  roles: [],
  expiresAt: 0,
};

export function hasRole(identity: Identity, roles: readonly string[]): boolean {
  return identity.roles.some((role) => roles.includes(role));
}

/**
 * Metadata the edge Worker attaches to the upgrade request. The shard trusts it
 * because only the Worker can address the Durable Object.
 */
export interface ConnectMetadata {
  identity: Identity;
  roomId: string;
  shardIndex: number;
  connectionId: string;
  connectedAt: number;
}

export const CONNECT_METADATA_HEADER = "x-chat-connect";

export function encodeConnectMetadata(meta: ConnectMetadata): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(meta))));
}

export function decodeConnectMetadata(raw: string | null): ConnectMetadata | null {
  if (!raw) return null;
  try {
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as ConnectMetadata;
  } catch {
    return null;
  }
}
