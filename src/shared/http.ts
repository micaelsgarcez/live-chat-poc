/** Tiny HTTP helpers + the edge router used by `src/worker.ts`. */
import type { Env } from "../env";

export interface RouteMatch {
  params: Record<string, string>;
}

export type RouteHandler = (
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  match: RouteMatch,
) => Response | Promise<Response>;

export interface RouteDef {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
  /** `/api/rooms/:roomId/bans` — `:name` captures one path segment. */
  path: string;
  handler: RouteHandler;
}

interface CompiledRoute extends RouteDef {
  segments: string[];
}

export class Router {
  private readonly routes: CompiledRoute[] = [];

  add(route: RouteDef): this {
    this.routes.push({ ...route, segments: route.path.split("/").filter(Boolean) });
    return this;
  }

  addAll(routes: readonly RouteDef[]): this {
    for (const route of routes) this.add(route);
    return this;
  }

  match(method: string, pathname: string): { route: CompiledRoute; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== "*" && route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
        else if (seg !== part) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return null;
  }

  async handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
    const url = new URL(req.url);
    const found = this.match(req.method, url.pathname);
    if (!found) return null;
    return found.route.handler(req, env, ctx, { params: found.params });
  }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

export function problem(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error: { code, message, ...extra } }, { status });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const url = new URL(req.url);
  return url.searchParams.get("token");
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "127.0.0.1"
  );
}

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-moderator-key",
  "access-control-max-age": "86400",
};

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
