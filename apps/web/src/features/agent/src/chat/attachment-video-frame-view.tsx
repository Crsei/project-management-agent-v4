import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@agent/components/ui/dialog";
import { useAgentText } from "../i18n";
import { captureVideoFirstFrame, videoPreviewPlan, type VideoAttachmentSource } from "./attachment-video-frame";

type VideoThumbnailState = { readonly status: "idle" } | { readonly status: "ready"; readonly url: string } | { readonly status: "unavailable" };

/**
 * Capture a local video's first frame once per blob. Anything that is not a
 * local blob (remote or data URL) is passed as `undefined` by the plan, so it
 * is never fetched or decoded behind the user's back.
 */
function useVideoThumbnail(file: Blob | undefined, size = 64): VideoThumbnailState {
  const [state, setState] = useState<VideoThumbnailState>({ status: "idle" });
  useEffect(() => {
    if (!file) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "idle" });
    void captureVideoFirstFrame(file, { size }).then(url => {
      if (!cancelled) setState(url ? { status: "ready", url } : { status: "unavailable" });
    });
    return () => { cancelled = true; };
  }, [file, size]);
  return state;
}

/**
 * Video tile media: a real first frame when the composer still holds the local
 * file, otherwise the same file card as any other attachment. The preview
 * dialog plays the local object URL, so no remote or embedded URL is loaded
 * until the user opens it.
 */
export function VideoAttachmentFrame({ attachment, url }: { attachment: VideoAttachmentSource & { name: string }; url: string | undefined }) {
  const t = useAgentText();
  const plan = videoPreviewPlan(attachment);
  const frame = useVideoThumbnail(plan.kind === "local-file" ? plan.file : undefined);
  if (frame.status !== "ready" || !url) return <span className="composer-attachment-file" aria-hidden="true"><Play /></span>;
  return <Dialog>
    <DialogTrigger render={<button type="button" className="composer-attachment-preview" aria-label={t(`预览视频 ${attachment.name}`, `Preview video ${attachment.name}`)}><img src={frame.url} alt="" /></button>} />
    <DialogContent className="max-w-3xl"><DialogTitle>{attachment.name}</DialogTitle><video src={url} controls playsInline preload="metadata" className="max-h-[75vh] w-full" aria-label={attachment.name} /></DialogContent>
  </Dialog>;
}
