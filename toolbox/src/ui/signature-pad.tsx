import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

export interface SignaturePadHandle {
  clear: () => void;
  isEmpty: () => boolean;
  toDataUrl: (type?: string) => string;
}

/** Draws like a paper form: a baseline with an X, so people sign where they expect to. */
export const SignaturePad = forwardRef<
  SignaturePadHandle,
  { height?: number; onEnd?: (dataUrl: string) => void; className?: string }
>(function SignaturePad({ height = 180, onEnd, className }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const empty = useRef(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * scale;
    canvas.height = rect.height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(scale, scale);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = getComputedStyle(canvas).color;

    const point = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const down = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      drawing.current = true;
      empty.current = false;
      const { x, y } = point(event);
      ctx.beginPath();
      ctx.moveTo(x, y);
    };
    const move = (event: PointerEvent) => {
      if (!drawing.current) return;
      const { x, y } = point(event);
      ctx.lineTo(x, y);
      ctx.stroke();
    };
    const up = () => {
      if (!drawing.current) return;
      drawing.current = false;
      onEnd?.(canvas.toDataURL('image/png'));
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', up);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointerleave', up);
    };
  }, [onEnd]);

  useImperativeHandle(ref, () => ({
    clear: () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      empty.current = true;
    },
    isEmpty: () => empty.current,
    toDataUrl: (type = 'image/png') => canvasRef.current?.toDataURL(type) ?? '',
  }));

  return (
    <div className={cn('relative rounded-md border border-line bg-surface', className)}>
      <canvas
        ref={canvasRef}
        style={{ height, touchAction: 'none' }}
        className="w-full text-ink"
        aria-label="Signature area"
      />
      <div className="pointer-events-none absolute inset-x-6 bottom-9 border-b border-dashed border-line" />
      <span className="pointer-events-none absolute bottom-10 left-6 font-display text-lg text-ink-muted">
        x
      </span>
      <span className="pointer-events-none absolute bottom-3 left-6 text-[11px] text-ink-muted">
        Sign above the line
      </span>
    </div>
  );
});
