import { useCallback, useEffect, useRef, useState } from 'react';
import { postMessage } from '../vscode';

// Konami Code hook
// Up Up Down Down Left Right Left Right B A

const KONAMI_SEQUENCE = [
  'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
  'b', 'a',
];

export function useKonamiCode(onMatch: () => void) {
  const seqRef = useRef<string[]>([]);
  const stableOnMatch = useRef(onMatch);
  stableOnMatch.current = onMatch;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      seqRef.current = [...seqRef.current, key].slice(-KONAMI_SEQUENCE.length);
      if (seqRef.current.join(',') === KONAMI_SEQUENCE.join(',')) {
        seqRef.current = [];
        stableOnMatch.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}

// Matrix Rain overlay

const MATRIX_CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF';

export function MatrixRainOverlay({ onDismiss }: { onDismiss: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stableDismiss = useRef(onDismiss);
  stableDismiss.current = onDismiss;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const fontSize = 14;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    const cols = () => Math.floor(canvas.width / fontSize);
    let drops = Array.from({ length: cols() }, () => Math.random() * -80);

    let frame = 0;
    const interval = setInterval(() => {
      frame++;

      // Ensure drops array matches canvas width
      const numCols = cols();
      while (drops.length < numCols) drops.push(Math.random() * -80);
      drops = drops.slice(0, numCols);

      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < drops.length; i++) {
        const ch = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
        const y = drops[i] * fontSize;

        // Bright lead character
        ctx.fillStyle = '#afffaf';
        ctx.fillText(ch, i * fontSize, y);

        // Slightly dimmer trail character
        if (drops[i] > 1) {
          ctx.fillStyle = '#00cc44';
          ctx.fillText(MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)], i * fontSize, y - fontSize);
        }

        if (y > canvas.height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i] += 0.5;
      }

      // Show message after ~2 seconds
      if (frame > 60) {
        const title = 'YOU FOUND THE MCP MATRIX';
        const sub = 'All tools belong to us';
        const hint = '[click or press any key to exit]';

        ctx.font = 'bold 26px monospace';
        const titleW = ctx.measureText(title).width;
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(cx - titleW / 2 - 28, cy - 56, titleW + 56, 130);

        ctx.textAlign = 'center';
        ctx.fillStyle = '#00ff44';
        ctx.font = 'bold 26px monospace';
        ctx.fillText(title, cx, cy - 14);

        ctx.fillStyle = '#88ff88';
        ctx.font = '15px monospace';
        ctx.fillText(sub, cx, cy + 16);

        ctx.fillStyle = '#44aa44';
        ctx.font = '12px monospace';
        ctx.fillText(hint, cx, cy + 52);
        ctx.textAlign = 'left';
      }
    }, 33);

    return () => {
      clearInterval(interval);
      window.removeEventListener('resize', resize);
    };
  }, []);

  // Dismiss on any keydown (after a tiny delay so the 'a' from Konami doesn't instantly close it)
  useEffect(() => {
    const timeout = setTimeout(() => {
      const handler = () => stableDismiss.current();
      window.addEventListener('keydown', handler, { once: true });
      return () => window.removeEventListener('keydown', handler);
    }, 800);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      onClick={() => stableDismiss.current()}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#000', cursor: 'pointer' }}
    />
  );
}

// "42" Douglas Adams toast

export function FortyTwoToast() {
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  return (
    <div className="easter-egg-toast" onClick={() => setVisible(false)} title="Click to dismiss">
      <span className="easter-egg-toast-num">42</span>
      <span className="easter-egg-toast-text">
        "The Answer to Life, the Universe, and Everything."
      </span>
      <button className="easter-egg-toast-close" onClick={() => setVisible(false)}>✕</button>
    </div>
  );
}

// Confetti + GitHub star overlay

const CONFETTI_COLORS = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#c77dff', '#f8961e', '#00bbf9', '#ff9f1c'];

const GITHUB_URL = 'https://github.com/jurgen178/mcp-tool-explorer';

interface ConfettiPiece {
  id: number;
  left: number;
  color: string;
  delay: number;
  duration: number;
  size: number;
  rotate: number;
  isCircle: boolean;
}

function makePieces(): ConfettiPiece[] {
  return Array.from({ length: 90 }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    delay: Math.random() * 1.0,
    duration: 2.0 + Math.random() * 1.5,
    size: 6 + Math.random() * 9,
    rotate: Math.random() * 360,
    isCircle: Math.random() > 0.5,
  }));
}

export function ConfettiOverlay({ onDismiss }: { onDismiss: () => void }) {
  const [pieces] = useState<ConfettiPiece[]>(makePieces);

  const openGitHub = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    postMessage({ type: 'openExternal', url: GITHUB_URL });
  }, []);

  return (
    <div className="easter-egg-confetti-overlay" onClick={onDismiss}>
      {pieces.map(p => (
        <div
          key={p.id}
          className="confetti-piece"
          style={{
            left: `${p.left}%`,
            background: p.color,
            width: p.size,
            height: p.isCircle ? p.size : p.size * 0.6,
            borderRadius: p.isCircle ? '50%' : '2px',
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            transform: `rotate(${p.rotate}deg)`,
          }}
        />
      ))}
      <div className="easter-egg-confetti-card" onClick={e => e.stopPropagation()}>
        <div className="easter-egg-confetti-emoji">🎉</div>
        <div className="easter-egg-confetti-title">Easter Egg found!</div>
        <div className="easter-egg-confetti-sub">Enjoying MCP Tool Explorer?</div>
        <button className="easter-egg-github-btn" onClick={openGitHub}>
          ⭐ Star us on GitHub
        </button>
        <div className="easter-egg-confetti-hint">click anywhere to dismiss</div>
      </div>
    </div>
  );
}
