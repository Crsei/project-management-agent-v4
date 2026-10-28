"use client"
import { useEffect, useId, useRef, useState } from "react"
import { Button } from "../ui/button"
import { useI18n } from "../../lib/i18n-provider"
import { useControllableValue } from "../../lib/use-controllable-value"
import { cn } from "../../lib/utils"
export type ImageUploadProps = {
  label: string
  value?: File | null
  defaultValue?: File | null
  onValueChange?: (file: File | null) => void
  accept?: string
  maxBytes?: number
  disabled?: boolean
  className?: string
}
function readImage(file: File, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    const image = new Image()
    const cleanup = () => {
      signal.removeEventListener("abort", abort)
      reader.onload = reader.onerror = reader.onabort = null
      image.onload = image.onerror = null
      image.src = ""
    }
    const fail = () => {
      cleanup()
      reject(new Error("read"))
    }
    const abort = () => {
      if (reader.readyState === 1) reader.abort()
      fail()
    }
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener("abort", abort, { once: true })
    reader.onerror = fail
    reader.onabort = fail
    reader.onload = () => {
      const src = String(reader.result)
      image.onload = () => {
        cleanup()
        resolve(src)
      }
      image.onerror = fail
      image.src = src
    }
    reader.readAsDataURL(file)
  })
}
function accepts(file: File, accept: string) {
  return (
    file.type.startsWith("image/") &&
    accept.split(",").some((raw) => {
      const part = raw.trim().toLowerCase()
      return part.startsWith(".")
        ? file.name.toLowerCase().endsWith(part)
        : part.endsWith("/*")
          ? file.type.startsWith(part.slice(0, -1))
          : file.type === part
    })
  )
}
export function ImageUpload({
  label,
  value: controlled,
  defaultValue = null,
  onValueChange,
  accept = "image/*",
  maxBytes = 5 * 1024 * 1024,
  disabled,
  className,
}: ImageUploadProps) {
  const { t } = useI18n()
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [value, change] = useControllableValue(
    controlled,
    defaultValue,
    onValueChange,
  )
  const [preview, setPreview] = useState<{ file: File; src: string } | null>(
    null,
  )
  const [error, setError] = useState<"type" | "size" | "read" | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  useEffect(() => {
    pending.current?.abort()
    if (!value) return
    const request = new AbortController()
    readImage(value, request.signal)
      .then((src) => {
        if (!request.signal.aborted) setPreview({ file: value, src })
      })
      .catch(() => {
        if (!request.signal.aborted) setError("read")
      })
    return () => request.abort()
  }, [value, disabled])
  async function choose(file?: File) {
    if (!file || disabled) return
    pending.current?.abort()
    const request = new AbortController()
    pending.current = request
    setBusy(false)
    if (!accepts(file, accept)) {
      setError("type")
      return
    }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0 || file.size > maxBytes) {
      setError("size")
      return
    }
    setError(null)
    setBusy(true)
    try {
      const src = await readImage(file, request.signal)
      if (request.signal.aborted) return
      setPreview({ file, src })
      change(file)
    } catch {
      if (!request.signal.aborted) setError("read")
    } finally {
      if (pending.current === request) setBusy(false)
    }
  }
  const errorText = error
    ? t(
        error === "type"
          ? "commonComponents.imageType"
          : error === "size"
            ? "commonComponents.imageSize"
            : "commonComponents.imageRead",
      )
    : null
  return (
    <div className={className} aria-busy={busy}>
      <div
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={errorText ? `${id}-error` : undefined}
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void choose(event.dataTransfer.files[0])
        }}
        className={cn(
          "rounded-md border border-dashed p-4",
          dragging && "border-primary bg-selection",
          disabled && "opacity-50",
        )}
      >
        <p id={`${id}-label`} className="mb-2 text-sm font-medium">
          {label}
        </p>
        {value && preview?.file === value && (
          // eslint-disable-next-line @next/next/no-img-element -- Local file preview, portable component.
          <img
            src={preview.src}
            alt={value.name}
            className="mb-3 size-20 rounded-md object-cover"
          />
        )}
        {value && <p className="mb-2 break-all text-xs">{value.name}</p>}
        <input
          id={id}
          ref={input}
          type="file"
          accept={accept}
          disabled={disabled}
          aria-label={label}
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            void choose(event.target.files?.[0])
            event.target.value = ""
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            {value
              ? t("commonComponents.replaceImage")
              : t("commonComponents.chooseImage")}
          </Button>
          {value && (
            <Button
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                pending.current?.abort()
                pending.current = null
                setBusy(false)
                setError(null)
                change(null)
              }}
            >
              {t("commonComponents.removeImage")}
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("commonComponents.localPreview")}
        </p>
      </div>
      {busy && (
        <p role="status" className="mt-1 text-xs">
          {t("commonComponents.readingImage")}
        </p>
      )}
      {errorText && (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1 text-xs text-destructive"
        >
          {errorText}
        </p>
      )}
    </div>
  )
}
