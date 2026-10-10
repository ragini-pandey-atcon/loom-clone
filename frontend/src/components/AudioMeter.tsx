import { useEffect, useRef } from 'react';

/** Live microphone level, so people can see the right mic is picked before they record. */
export function AudioMeter({ stream, label }: { stream: MediaStream | null; label: string }) {
  const bar = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      if (bar.current) bar.current.style.transform = 'scaleX(0)';
      return;
    }
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      const level = Math.min(1, (peak / 128) * 2.2);
      if (bar.current) bar.current.style.transform = `scaleX(${level.toFixed(3)})`;
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      void ctx.close();
    };
  }, [stream]);

  return (
    <div className="meter" role="img" aria-label={label}>
      <span ref={bar} style={{ transform: 'scaleX(0)' }} />
    </div>
  );
}
