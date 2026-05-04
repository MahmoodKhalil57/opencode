import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSignal, type Component } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { DialogConnectProvider } from "./dialog-connect-provider"

/**
 * Tiny intermediate dialog that runs BEFORE DialogConnectProvider when the
 * user clicks "+ Add another" on an already-connected provider. Asks for a
 * unique credential name (suggesting `<provider>-2`, `-3`, ... based on
 * existing entries), then opens DialogConnectProvider with that alias so
 * the new credential is saved under the chosen name instead of replacing
 * the existing one.
 *
 * Native opencode design system: <Dialog>, <TextField>, <Button>.
 */
export const DialogNameCredential: Component<{ provider: string; providerName: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const globalSync = useGlobalSync()

  const suggested = () => {
    const knownIds = new Set([
      ...globalSync.data.provider.all.map((p) => p.id),
      ...globalSync.data.provider.connected.map((p) => p.id),
    ])
    let n = 2
    while (knownIds.has(`${props.provider}-${n}`)) n++
    return `${props.provider}-${n}`
  }

  const [name, setName] = createSignal(suggested())
  const [error, setError] = createSignal<string | undefined>(undefined)

  const submit = () => {
    const value = name().trim()
    if (!value) {
      setError(language.t("provider.connect.alias.required"))
      return
    }
    if (value === props.provider) {
      setError(language.t("provider.connect.alias.differentRequired"))
      return
    }
    const knownIds = new Set([
      ...globalSync.data.provider.all.map((p) => p.id),
      ...globalSync.data.provider.connected.map((p) => p.id),
    ])
    if (knownIds.has(value)) {
      setError(language.t("provider.connect.alias.alreadyExists"))
      return
    }
    dialog.show(() => <DialogConnectProvider provider={props.provider} alias={value} />)
  }

  return (
    <Dialog>
      <Dialog.Title>
        {language.t("provider.connect.alias.title", { provider: props.providerName })}
      </Dialog.Title>
      <div class="flex flex-col gap-3 px-6 py-4">
        <p class="text-13-regular text-text-base">
          {language.t("provider.connect.alias.description", { provider: props.providerName })}
        </p>
        <TextField
          label={language.t("provider.connect.alias.label")}
          value={name()}
          onInput={(e) => {
            setName(e.currentTarget.value)
            setError(undefined)
          }}
          placeholder={language.t("provider.connect.alias.placeholder", { provider: props.provider })}
          error={error()}
          autofocus
        />
      </div>
      <Dialog.Footer>
        <Button variant="ghost" onClick={() => dialog.hide()}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="primary" onClick={submit}>
          {language.t("provider.connect.alias.continue")}
        </Button>
      </Dialog.Footer>
    </Dialog>
  )
}
