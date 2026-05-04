import { Auth } from "@/auth"
import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import { mapValues } from "remeda"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const authSvc = yield* Auth.Service

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const config = yield* cfg.get()
      const all = yield* ModelsDev.Service.use((s) => s.get())
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const filtered: Record<string, (typeof all)[string]> = {}
      for (const [key, value] of Object.entries(all)) {
        if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) filtered[key] = value
      }
      const connected = yield* provider.list()
      const providers = Object.assign(
        mapValues(filtered, (item) => Provider.fromModelsDevProvider(item)),
        connected,
      )
      // cheapcode fork: surface aliased credentials linked to canonical providers.
      // Prefer the explicit providerID metadata recorded on aliased saves; fall
      // back to a longest-prefix match against connected providers for older
      // entries saved before we tracked the link.
      const authEntries = yield* authSvc.all().pipe(Effect.orElseSucceed(() => ({})))
      const inferProvider = (key: string): string | undefined => {
        let best: string | undefined
        for (const id of Object.keys(connected)) {
          if (id !== key && key.startsWith(`${id}-`) && (!best || id.length > best.length)) best = id
        }
        return best
      }
      const credentials = Object.entries(authEntries).flatMap(([key, entry]) => {
        if (connected[key]) return []
        const linkedProviderID =
          (entry as { providerID?: string }).providerID ?? inferProvider(key)
        if (!linkedProviderID || !connected[linkedProviderID]) return []
        return [{ key, providerID: linkedProviderID, type: entry.type }]
      })
      return {
        all: Object.values(providers),
        default: Provider.defaultModelIDs(providers),
        connected: Object.keys(connected),
        ...(credentials.length > 0 ? { credentials } : {}),
      }
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* svc
        .authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        })
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const result = yield* authorize({ params: ctx.params, payload })
      if (result === undefined) return HttpServerResponse.empty({ status: 200 })
      return HttpServerResponse.jsonUnsafe(result)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderID }
      payload: ProviderAuth.CallbackInput
    }) {
      yield* svc
        .callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
          alias: ctx.payload.alias,
        })
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)
