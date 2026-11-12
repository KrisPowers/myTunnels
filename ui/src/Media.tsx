import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { bytes, fileUrl, thumbUrl, type FileEntry } from "./api";
import { extOf } from "./Files";
import { Icon } from "./Icon";

// Photos and videos in Storage: the preview made when one is uploaded, the
// picture a tile shows, and the viewer that opens one over everything.

const PHOTOS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff"];
const VIDEOS = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp", "mts", "m2ts", "wmv"];
// What browsers can show by themselves; the rest are kept and downloaded.
const SHOWN = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "mp4", "m4v", "webm", "mov"];

export const isVideo = (name: string) => VIDEOS.includes(extOf(name));
export const isPhoto = (name: string) => PHOTOS.includes(extOf(name));
const shows = (name: string) => SHOWN.includes(extOf(name));

// Waits for `event` on `el`, or gives up after a while.
function once(el: HTMLElement, event: string, ms = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    el.addEventListener(event, () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
    el.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("unreadable"));
    }, { once: true });
  });
}

// makeThumb draws a small JPEG of a photo, or of a frame a second into a
// video, its short side 480 pixels; null when the browser cannot read it.
export async function makeThumb(file: File): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    let source: CanvasImageSource;
    let w: number;
    let h: number;
    if (isVideo(file.name)) {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.src = url;
      await once(v, "loadeddata");
      const seeked = once(v, "seeked");
      v.currentTime = Math.min(1, (v.duration || 0) / 2);
      await seeked;
      [source, w, h] = [v, v.videoWidth, v.videoHeight];
    } else {
      const bitmap = await createImageBitmap(file);
      [source, w, h] = [bitmap, bitmap.width, bitmap.height];
    }
    if (!w || !h) return null;
    const scale = Math.min(1, 480 / Math.min(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Thumb is a tile's picture, of the file at `path`: its preview, else the photo
// itself where the browser can show it, else a plain mark.
export function Thumb({ path }: { path: string }) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const [stage, setStage] = useState(0);
  if (stage === 2) return <span className="m-none"><Icon name={isVideo(name) ? "movie" : "image"} size={36} /></span>;
  return (
    <img src={stage === 0 ? thumbUrl(path) : fileUrl(path, true)} alt="" loading="lazy" draggable={false}
      onError={() => setStage(stage === 0 && !isVideo(name) && shows(name) ? 1 : 2)} />
  );
}

const dayOf = (at: number) => new Date(at * 1000).toLocaleDateString([], { dateStyle: "long" });

// Viewer shows one photo or video over everything, with the ones either side
// a click or an arrow key away. `dir` is the folder they are in.
export function Viewer({ dir, items, at, onMove, onClose, onDownload, onDelete }: {
  dir: string;
  items: FileEntry[];
  at: number;
  onMove: (at: number) => void;
  onClose: () => void;
  onDownload: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const e = items[at];
  const path = dir ? `${dir}/${e.name}` : e.name;
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      if (document.querySelector(".dialog-scrim")) return;
      if (ev.key === "Escape") onClose();
      if (ev.key === "ArrowLeft" && at > 0) onMove(at - 1);
      if (ev.key === "ArrowRight" && at < items.length - 1) onMove(at + 1);
    };
    document.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = overflow;
    };
  }, [at, items.length, onClose, onMove]);

  return createPortal(
    <div className="m-viewer" role="dialog" aria-modal="true" aria-label={e.name}>
      <div className="m-viewer-bar">
        <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}><Icon name="arrow_back" /></button>
        <div className="m-viewer-title">
          <b>{e.name}</b>
          <small>{dayOf(e.modified)} · {bytes(e.size)}</small>
        </div>
        <button type="button" className="icon-btn" aria-label="Download" title="Download" onClick={() => onDownload(e.name)}><Icon name="download" /></button>
        <button type="button" className="icon-btn" aria-label="Delete" title="Delete" onClick={() => onDelete(e.name)}><Icon name="delete" /></button>
      </div>
      <div className="m-stage" onClick={(ev) => ev.target === ev.currentTarget && onClose()}>
        {!shows(e.name) ? (
          <div className="m-none big"><Icon name={isVideo(e.name) ? "movie" : "image"} size={56} /><span>This browser cannot show {extOf(e.name).toUpperCase()} files. Download it to open it.</span></div>
        ) : isVideo(e.name) ? (
          <video key={e.name} src={fileUrl(path, true)} controls autoPlay playsInline />
        ) : (
          <img key={e.name} src={fileUrl(path, true)} alt={e.name} />
        )}
        {at > 0 && <button type="button" className="m-step prev" aria-label="Previous" onClick={() => onMove(at - 1)}><Icon name="chevron_left" size={32} /></button>}
        {at < items.length - 1 && <button type="button" className="m-step next" aria-label="Next" onClick={() => onMove(at + 1)}><Icon name="chevron_right" size={32} /></button>}
      </div>
    </div>,
    document.body,
  );
}
