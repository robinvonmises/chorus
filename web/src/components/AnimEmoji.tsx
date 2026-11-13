import { useEffect, useRef, useState } from 'react';
import { emojiCode, reducedMotion, useFx } from '../effects';

/**
 * Emoji-Nachrichten (groß dargestellt) mit Noto-Animation (animiertes WebP über /api/emoji, vom Server zwischengespeichert).
 * Schonend für Safari: animiert wird nur, solange die Nachricht zu sehen ist, und höchstens MAX Emojis gleichzeitig.
 * Bis die Animation geladen ist (oder wenn es keine gibt), steht das normale Emoji da.
 */
const MAX = 8;
const live = new Set<object>();
const failed = new Set<string>();
const loaded = new Set<string>();

const seg = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (t: string) => (seg ? [...seg.segment(t)].map((s) => s.segment) : [...t]);

export function BigEmoji({ text }: { text: string }) {
  const on = useFx('animEmoji');
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const token = {};
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && live.size < MAX) { live.add(token); setVisible(true); }
      else if (!e.isIntersecting) { live.delete(token); setVisible(false); }
    }, { rootMargin: '80px 0px' });
    io.observe(el);
    return () => { io.disconnect(); live.delete(token); };
  }, [on]);
  const parts = graphemes(text.trim());
  return <div className="text" ref={ref}>{parts.map((g, i) => (/^\s+$/.test(g) ? g : <Glyph key={i} g={g} live={on && visible} />))}</div>;
}

function Glyph({ g, live: play }: { g: string; live: boolean }) {
  const code = emojiCode(g);
  const [ok, setOk] = useState(() => loaded.has(code));
  const [, bump] = useState(0);
  if (!play || failed.has(code)) return <span>{g}</span>;
  return (
    <span className={`anim-emoji${ok ? ' ok' : ''}`}>
      <span>{g}</span>
      <img src={`/api/emoji/${code}.webp`} alt="" decoding="async" style={ok ? undefined : { opacity: 0 }}
        onLoad={() => { loaded.add(code); setOk(true); }} onError={() => { failed.add(code); bump((n) => n + 1); }} />
    </span>
  );
}
