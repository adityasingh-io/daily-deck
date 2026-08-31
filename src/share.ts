import type { Card } from "./types";
import { TOPIC_LABEL, TOPIC_TINT } from "./labels";

/* Renders a card as a 1080x1350 branded PNG and hands it to the native share
   sheet (download fallback). Pure canvas — no dependencies. Cross-origin
   images that refuse CORS simply fall back to a text-only share card. */

export function cardLink(card: Card): string {
  return `${location.origin}${import.meta.env.BASE_URL}#/c/${card.deckDate ?? "any"}/${encodeURIComponent(card.id)}`;
}

/** Share a link that opens this exact card on the site. */
export async function shareLink(card: Card): Promise<void> {
  const url = cardLink(card);
  if (navigator.share) {
    try {
      await navigator.share({ title: card.title, text: card.body, url });
      return;
    } catch {
      return; /* user cancelled */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    window.alert("Link copied to clipboard.");
  } catch {
    window.prompt("Copy this link:", url);
  }
}

const W = 1080;
const H = 1350;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else {
      line = test;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (line && lines.length === maxLines) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s+\S*$/, "") + "…";
  return lines;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const t = setTimeout(() => reject(new Error("timeout")), 6000);
    img.onload = () => {
      clearTimeout(t);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(t);
      reject(new Error("load failed"));
    };
    img.src = url;
  });
}

export async function shareCard(card: Card): Promise<void> {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const tint = TOPIC_TINT[card.topic] ?? "#93A2F2";

  ctx.fillStyle = "#141519";
  ctx.fillRect(0, 0, W, H);

  // Cover image (best effort — CORS-hostile hosts get the text-only layout)
  let y = 110;
  if (card.imageUrl) {
    try {
      const img = await loadImage(card.imageUrl);
      const ih = 540;
      const scale = Math.max(W / img.width, ih / img.height);
      const sw = W / scale;
      const sh = ih / scale;
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, W, ih);
      const g = ctx.createLinearGradient(0, ih - 260, 0, ih);
      g.addColorStop(0, "rgba(20,21,25,0)");
      g.addColorStop(1, "rgba(20,21,25,1)");
      ctx.fillStyle = g;
      ctx.fillRect(0, ih - 260, W, 260);
      y = 620;
    } catch {
      /* text-only layout */
    }
  }

  // Topic chip
  ctx.font = '600 26px "Bricolage Grotesque", sans-serif';
  const label = (TOPIC_LABEL[card.topic] ?? card.topic).toUpperCase();
  ctx.fillStyle = tint;
  ctx.fillText(label, 72, y);
  y += 66;

  // Title
  ctx.font = '700 62px "Bricolage Grotesque", sans-serif';
  ctx.fillStyle = "#E9E7E0";
  for (const line of wrap(ctx, card.title, W - 144, 4)) {
    ctx.fillText(line, 72, y);
    y += 74;
  }
  y += 26;

  // Body
  ctx.font = '400 36px "Newsreader", Georgia, serif';
  ctx.fillStyle = "#C9C7C0";
  for (const line of wrap(ctx, card.body, W - 144, 6)) {
    ctx.fillText(line, 72, y);
    y += 52;
  }

  // Footer: deckmark + wordmark + attribution
  const fy = H - 96;
  ctx.strokeStyle = "#4A4D55";
  ctx.lineWidth = 3;
  for (const [dx, rot, fill] of [
    [0, -0.1, "#1E2025"],
    [16, 0.03, "#262930"],
    [32, 0.16, "#272C44"],
  ] as const) {
    ctx.save();
    ctx.translate(84 + dx, fy - 2);
    ctx.rotate(rot);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(-14, -22, 30, 44, 5);
    ctx.fill();
    if (dx === 32) ctx.strokeStyle = tint;
    ctx.stroke();
    ctx.restore();
  }
  ctx.font = '600 30px "Bricolage Grotesque", sans-serif';
  ctx.fillStyle = "#E9E7E0";
  ctx.fillText("Daily Deck", 150, fy + 10);
  ctx.font = '400 24px "Bricolage Grotesque", sans-serif';
  ctx.fillStyle = "#9A9DA5";
  const attr = card.attribution;
  ctx.fillText(attr, W - 72 - ctx.measureText(attr).width, fy + 10);

  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) return;
  const file = new File([blob], "daily-deck-card.png", { type: "image/png" });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: card.title });
      return;
    } catch {
      /* user cancelled or share failed — fall through to download */
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "daily-deck-card.png";
  a.click();
  URL.revokeObjectURL(a.href);
}
