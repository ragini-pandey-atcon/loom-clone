import { useEffect, useRef } from 'react';

/** A muted <video> showing a MediaStream (camera preview, or the composite being recorded). */
export function LiveVideo({ stream, label }: { stream: MediaStream | null; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) el.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} muted playsInline autoPlay aria-label={label} />;
}
