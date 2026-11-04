/**
 * Share cards: a picture of a win, a streak or a rating, drawn on a canvas
 * in ChessFront's colours, sent with the phone's share sheet (WhatsApp,
 * Instagram, X…). Where a browser can't share pictures, the picture is
 * saved and a WhatsApp message with the link opens instead.
 */
import { toast } from './store';

export interface ShareCard {
  kicker: string;
  title: string;
  lines: string[];
  /** Big number in the corner, e.g. a streak. */
  badge?: { value: string; label: string };
  url: string;
}

const W = 1080;
const H = 1080;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

export async function drawCard(card: ShareCard): Promise<Blob> {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  await document.fonts?.ready.catch(() => {});
  // Walnut background with a soft gold glow.
  const bg = ctx.createRadialGradient(W / 2, H * 0.35, 80, W / 2, H / 2, W * 0.8);
  bg.addColorStop(0, '#3a2a18');
  bg.addColorStop(1, '#0e0a06');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // A faint chessboard across the bottom.
  for (let r = 0; r < 4; r++)
    for (let f = 0; f < 8; f++) {
      ctx.fillStyle = (r + f) % 2 ? 'rgba(244,234,211,0.05)' : 'rgba(0,0,0,0.12)';
      ctx.fillRect(f * (W / 8), H - (4 - r) * 90, W / 8, 90);
    }
  ctx.strokeStyle = 'rgba(232,179,58,0.6)';
  ctx.lineWidth = 6;
  ctx.strokeRect(36, 36, W - 72, H - 72);

  ctx.fillStyle = '#e8b33a';
  ctx.font = '120px serif';
  ctx.textAlign = 'center';
  ctx.fillText('♜', W / 2, 220);
  ctx.font = '600 34px "Barlow Condensed", Arial, sans-serif';
  ctx.fillText(card.kicker.toUpperCase().split('').join(' '), W / 2, 300);

  ctx.fillStyle = '#f4ead3';
  ctx.font = '76px Marcellus, Georgia, serif';
  let y = 410;
  for (const l of wrap(ctx, card.title, W - 200)) {
    ctx.fillText(l, W / 2, y);
    y += 88;
  }
  ctx.fillStyle = '#d9cdb3';
  ctx.font = '40px "Barlow Condensed", Arial, sans-serif';
  y += 20;
  for (const line of card.lines) {
    for (const l of wrap(ctx, line, W - 220)) {
      ctx.fillText(l, W / 2, y);
      y += 54;
    }
  }
  if (card.badge) {
    ctx.fillStyle = 'rgba(232,179,58,0.15)';
    ctx.beginPath();
    ctx.arc(W - 170, 170, 100, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#e8b33a';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = '#e8b33a';
    ctx.font = '700 70px "Barlow Condensed", Arial, sans-serif';
    ctx.fillText(card.badge.value, W - 170, 190);
    ctx.font = '600 24px "Barlow Condensed", Arial, sans-serif';
    ctx.fillText(card.badge.label.toUpperCase(), W - 170, 228);
  }
  ctx.fillStyle = '#f4ead3';
  ctx.font = '64px Marcellus, Georgia, serif';
  ctx.fillText('ChessFront', W / 2, H - 150);
  ctx.fillStyle = '#9fb8de';
  ctx.font = '600 34px "Barlow Condensed", Arial, sans-serif';
  ctx.fillText('chessfront.app · The Living Chess Experience', W / 2, H - 95);
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('no image'))), 'image/png'));
}

export async function shareResult(card: ShareCard) {
  const text = `${card.title}. ${card.lines.join('. ')}. Play me on ChessFront:`;
  let blob: Blob | null = null;
  try {
    blob = await drawCard(card);
  } catch {
    /* text-only share */
  }
  const file = blob ? new File([blob], 'chessfront.png', { type: 'image/png' }) : null;
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  try {
    if (file && nav.canShare?.({ files: [file] })) {
      await nav.share({ files: [file], title: 'ChessFront', text: `${text} ${card.url}` });
      return;
    }
    if (nav.share) {
      await nav.share({ title: 'ChessFront', text, url: card.url });
      return;
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
  }
  // Desktop: save the picture and open WhatsApp with the message.
  if (blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chessfront.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(`${text} ${card.url}`)}`, '_blank', 'noopener');
  toast('Picture saved. Add it to your message.', 'good');
}
