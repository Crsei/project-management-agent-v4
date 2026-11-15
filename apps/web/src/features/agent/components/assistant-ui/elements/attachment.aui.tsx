"use client";

import { type PropsWithChildren, useState, type FC, isValidElement } from "react";
import { XIcon, PaperclipIcon } from "lucide-react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import { Dialog, DialogTitle, DialogContent, DialogTrigger } from "@agent/components/ui/dialog";
import { TooltipIconButton } from "@agent/components/assistant-ui/elements/tooltip-icon-button";
import { useAttachmentSrc } from "@agent/hooks/use-attachment-src";
import { cn } from "@agent/lib/utils";
import { useAgentText } from "@agent/src/i18n";
import { FileChip, ImageChipButton } from "@agent/src/chat/context-chip-parts";
import { ContextChipAction } from "@agent/src/chat/context-chip";
import { getExternalStoreMessages } from "@assistant-ui/core";
import type { UIMessage } from "ai";
import { bindClipboardContext } from "@agent/src/chat/message-context-clipboard";
import { clipboardComposerAttachment } from "@agent/src/chat/composer-context-attachments";
import { readContextAttachmentBindings } from "@agent/src/chat/context-attachments";

type AttachmentPreviewProps = {
  src: string;
  name: string;
};

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src, name }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      src={src}
      alt={`Preview of ${name}`}
      className={cn(
        "block h-auto max-h-[80vh] w-auto max-w-full rounded-sm object-contain transition-opacity duration-300 motion-reduce:transition-none",
        isLoaded
          ? "aui-attachment-preview-image-loaded opacity-100"
          : "aui-attachment-preview-image-loading opacity-0",
      )}
      onLoad={() => setIsLoaded(true)}
    />
  );
};

type AttachmentPreviewDialogProps = PropsWithChildren<{
  src: string | undefined;
  name: string;
}>;

const AttachmentPreviewDialog: FC<AttachmentPreviewDialogProps> = ({ children, src, name }) => {
  if (!src) return children;

  return (
    <Dialog>
      <DialogTrigger
        nativeButton={false}
        className="aui-attachment-preview-trigger cursor-zoom-in"
        render={isValidElement(children) ? children : <button type="button">{children}</button>}
      />
      <DialogContent className="aui-attachment-preview-dialog-content [&>button]:bg-foreground/60 [&>button]:hover:bg-foreground/80 [&_svg]:text-background p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0!">
        <DialogTitle className="aui-sr-only sr-only">Preview {name}</DialogTitle>
        <div className="aui-attachment-preview bg-background relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden rounded-sm">
          <AttachmentPreview src={src} name={name} />
        </div>
      </DialogContent>
    </Dialog>
  );
};


const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";
  const src = useAttachmentSrc();

  const isImage = useAuiState((s) => s.attachment.type === "image");
  const name = useAuiState((s) => s.attachment.name);
  const attachment = useAuiState(state => state.attachment);
  const message = useAuiState(state => state.optional.message);
  const original = message ? (getExternalStoreMessages(message) as UIMessage[]).at(-1) : undefined;
  const fileParts = original?.parts.flatMap((part, partIndex) => part.type === "file" ? [partIndex] : []) ?? [];
  const sourcePartIndex = fileParts[Number(attachment.id)];
  const sourceAttachmentId = sourcePartIndex === undefined ? undefined : readContextAttachmentBindings(message?.metadata.custom.contextAttachments).find(binding => binding.partIndex === sourcePartIndex)?.attachmentId;

  // An attachment on a submission is still being prepared, whether or not the
  // adapter reports progress while it uploads.
  const uploadState = useAuiState((s) =>
    s.attachment.status.type === "incomplete" && s.attachment.status.reason === "error"
      ? "error"
      : s.attachment.status.type === "running" ||
          (s.optional.message?.submission !== undefined && s.attachment.status.type !== "complete")
        ? "uploading"
        : undefined,
  );
  const isUploading = uploadState === "uploading";
  const isError = uploadState === "error";

  const errorMessage = useAuiState((s) =>
    s.attachment.status.type === "incomplete" && s.attachment.status.reason === "error"
      ? (s.attachment.status.message ?? "Upload failed")
      : undefined,
  );

  const sizeBytes = useAuiState(s => s.attachment.file?.size);
  const size = sizeBytes === undefined ? "" : sizeBytes < 1024 ? `${sizeBytes} B` : sizeBytes < 1024 * 1024 ? `${(sizeBytes / 1024).toFixed(1)} KiB` : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
  const suffix = isError ? errorMessage || "Upload failed" : isUploading ? "Preparing attachment…" : undefined;
  return <span data-message-context-record ref={element => { bindClipboardContext(element, () => ({ type: "attachment", attachment: clipboardComposerAttachment({ ...attachment, id: sourceAttachmentId || (message ? `message:${message.id}:${attachment.id}` : attachment.id) }) })); }}><AttachmentPrimitive.Root className="aui-attachment-root inline-flex max-w-full items-center gap-0.5 text-sm">
    {isImage ? <AttachmentPreviewDialog src={src} name={name}><ImageChipButton name={name} previewUrl={src} size={size} suffix={suffix} state={isError ? "invalid" : undefined} /></AttachmentPreviewDialog> : <FileChip name={name} size={size} suffix={suffix} error={isError} />}
    {isComposer && <AttachmentRemove name={name} />}
    {errorMessage && <span role="alert" className="sr-only">{errorMessage}</span>}
  </AttachmentPrimitive.Root></span>;
};

const AttachmentRemove: FC<{ name: string }> = ({ name }) => {
  return (
    <AttachmentPrimitive.Remove
      render={<ContextChipAction aria-label={`Remove ${name}`} title={`Remove ${name}`} />}
    >
      <XIcon className="aui-attachment-remove-icon size-3 stroke-[2.5]" />
    </AttachmentPrimitive.Remove>
  );
};

export const UserMessageAttachments: FC = () => {
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2 empty:hidden">
      <MessagePrimitive.Attachments>{() => <AttachmentUI />}</MessagePrimitive.Attachments>
    </div>
  );
};

export const ComposerAttachments: FC = () => {
  return (
    <div className="aui-composer-attachments flex w-full flex-row flex-wrap items-center gap-2 empty:hidden">
      <ComposerPrimitive.Attachments>{() => <AttachmentUI />}</ComposerPrimitive.Attachments>
    </div>
  );
};

export const ComposerAddAttachment: FC = () => {
  const t = useAgentText();
  return (
    <ComposerPrimitive.AddAttachment
      render={
        <TooltipIconButton
          tooltip={t("添加附件", "Add attachment")}
          side="bottom"
          variant="ghost"
          size="icon"
          className="aui-composer-add-attachment text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full active:bg-muted-foreground/25 motion-reduce:transition-none"
          aria-label={t("添加附件", "Add attachment")}
        />
      }
    >
      <PaperclipIcon aria-hidden="true" className="aui-attachment-add-icon size-4" />
    </ComposerPrimitive.AddAttachment>
  );
};
