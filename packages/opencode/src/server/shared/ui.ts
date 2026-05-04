import { Flag } from "@opencode-ai/core/flag/flag"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { ProxyUtil } from "../proxy-util"

const embeddedUIPromise = Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI
  ? Promise.resolve(null)
  : // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null)

export const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:"
// OPENCODE_UI_UPSTREAM env var lets a fork (e.g., cheapcode) point the runtime
// at a local app dev server (`bun --cwd packages/app dev` → http://localhost:5173)
// instead of the bundled-CDN'd default. Useful when iterating on UI patches
// without running the full embed-build pipeline.
export const UI_UPSTREAM = new URL(process.env.OPENCODE_UI_UPSTREAM ?? "https://app.opencode.ai")

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:`

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  return new URL(path, UI_UPSTREAM).toString()
}

export function embeddedUI() {
  if (Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI) return Promise.resolve(null)
  return embeddedUIPromise
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = AppFileSystem.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) headers.set("content-security-policy", DEFAULT_CSP)
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: AppFileSystem.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: AppFileSystem.Interface; client: HttpClient.HttpClient },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI())
    const path = new URL(request.url, "http://localhost").pathname

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI)

    // OPENCODE_UI_DIST env var: serve UI files from a local packages/app/dist
    // directory. Lets a fork (e.g. cheapcode) ship a custom-patched UI without
    // running the full embed-binary build pipeline. Falls through to upstream
    // proxy when the file isn't in the dist dir.
    const uiDist = process.env.OPENCODE_UI_DIST
    if (uiDist) {
      const cleanPath = path.replace(/^\//, "") || "index.html"
      const candidate = await import("node:path").then((p) => p.default.join(uiDist, cleanPath))
      const fileExists = yield* fs.readFile(candidate).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
      )
      if (fileExists) {
        const body = yield* fs.readFile(candidate)
        return embeddedUIResponse(candidate, body)
      }
      // SPA fallback: serve index.html for paths without an extension
      if (!cleanPath.includes(".")) {
        const indexCandidate = await import("node:path").then((p) => p.default.join(uiDist, "index.html"))
        const indexExists = yield* fs.readFile(indexCandidate).pipe(
          Effect.map(() => true),
          Effect.catchAll(() => Effect.succeed(false)),
        )
        if (indexExists) {
          const body = yield* fs.readFile(indexCandidate)
          return embeddedUIResponse(indexCandidate, body)
        }
      }
      // file not found in local dist; fall through to upstream proxy below
    }

    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(path), {
        headers: ProxyUtil.headers(request.headers, { host: UI_UPSTREAM.host }),
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = yield* response.text
      const match = themePreloadHash(body)
      headers.set("Content-Security-Policy", csp(match ? createHash("sha256").update(match[2]).digest("base64") : ""))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}
