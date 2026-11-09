import { useEffect, useRef } from "react";
import { tg } from "./api";

const R = 30;
const POINTER_RADIUS = 120;
const TOUCH_RADIUS = 80;
const AWAKE_MS = 9000;
const SPARK_EVERY_MS = 650;

interface Cell {
  x: number;
  y: number;
  e: number;
  green: boolean;
}

/**
 * Honeycomb backdrop, the lattice of the Skill Hive landing: flat-top hex cells light up near
 * the mouse, ripple under a tap and spark on their own for a while after any activity.
 * When nothing moves it rests on a static frame; one static frame under reduced motion.
 */
export function HexBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    const lattice = document.createElement("canvas");
    const latticeCtx = lattice.getContext("2d");
    if (!canvas || !ctx || !latticeCtx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let cells: Cell[] = [];
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let resizeRaf = 0;
    let running = false;
    let last = 0;
    let lastSpark = 0;
    let awakeUntil = 0;
    let light = false;
    let colors = { line: "", neon: "", green: "", spark: 0.45 };
    const pointer = { x: 0, y: 0, on: false };

    const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const readColors = () => {
      light = document.documentElement.dataset.theme === "light";
      colors = { line: css("--hex-line"), neon: css("--neon-rgb"), green: css("--green-rgb"), spark: Number.parseFloat(css("--spark-alpha")) || 0.45 };
    };

    const hexPath = (target: CanvasRenderingContext2D, x: number, y: number) => {
      const r = R - 1.5;
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        if (i === 0) target.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
        else target.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
      }
      target.closePath();
    };

    /** The static lattice is stroked once per size or theme; frames only blit it. */
    const paintLattice = () => {
      lattice.width = canvas.width;
      lattice.height = canvas.height;
      latticeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      latticeCtx.beginPath();
      for (const cell of cells) hexPath(latticeCtx, cell.x, cell.y);
      latticeCtx.strokeStyle = colors.line;
      latticeCtx.lineWidth = 1;
      latticeCtx.stroke();
    };

    const build = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      cells = [];
      const hStep = R * 1.5;
      const vStep = R * Math.sqrt(3);
      for (let col = 0; col * hStep < width + R * 2; col++) {
        const offset = col % 2 ? vStep / 2 : 0;
        for (let row = 0; row * vStep + offset < height + R * 2; row++) {
          cells.push({ x: col * hStep, y: row * vStep + offset, e: 0, green: false });
        }
      }
      paintLattice();
    };

    const draw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // drawImage throws on a zero-sized canvas (a collapsed webview reports a 0×0 window).
      if (lattice.width > 0 && lattice.height > 0) ctx.drawImage(lattice, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 1;
      for (const cell of cells) {
        if (cell.e <= 0.02) continue;
        const rgb = cell.green ? colors.green : colors.neon;
        ctx.beginPath();
        hexPath(ctx, cell.x, cell.y);
        ctx.fillStyle = `rgba(${rgb}, ${cell.e * 0.07})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${rgb}, ${cell.e * colors.spark})`;
        ctx.stroke();
      }
    };

    const charge = (x: number, y: number, radius: number) => {
      for (const cell of cells) {
        const distance = Math.hypot(cell.x - x, cell.y - y);
        if (distance >= radius) continue;
        const energy = 1 - distance / radius;
        if (energy > cell.e) {
          cell.e = energy;
          cell.green = false;
        }
      }
    };

    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
      canvas.dataset.state = "resting";
    };

    const frame = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const awake = now < awakeUntil;
      if (awake && now - lastSpark > SPARK_EVERY_MS && cells.length > 0) {
        lastSpark = now;
        const cell = cells[Math.floor(Math.random() * cells.length)]!;
        cell.e = 1;
        cell.green = !light && Math.random() < 0.25;
      }
      if (awake && pointer.on) charge(pointer.x, pointer.y, POINTER_RADIUS);
      draw();
      const decay = Math.pow(0.965, dt / 16.7);
      let lit = false;
      for (const cell of cells) {
        if (cell.e <= 0.02) continue;
        cell.e *= decay;
        if (cell.e > 0.02) lit = true;
      }
      if (!awake && !lit) {
        draw();
        stop();
        return;
      }
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (running || reduced) return;
      running = true;
      canvas.dataset.state = "live";
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const wake = () => {
      awakeUntil = performance.now() + AWAKE_MS;
      start();
    };

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse") {
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        pointer.on = true;
      } else charge(event.clientX, event.clientY, TOUCH_RADIUS);
      wake();
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.on = true;
      wake();
    };
    const onLeave = () => {
      pointer.on = false;
    };
    const onVisibility = () => (document.hidden ? stop() : wake());
    const onResize = () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        build();
        if (!running) draw();
      });
    };
    const theme = new MutationObserver(() => {
      readColors();
      paintLattice();
      if (!running) draw();
    });

    readColors();
    build();
    draw();
    canvas.dataset.state = "resting";
    window.addEventListener("resize", onResize);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    if (reduced) {
      return () => {
        cancelAnimationFrame(resizeRaf);
        theme.disconnect();
        window.removeEventListener("resize", onResize);
      };
    }

    window.addEventListener("pointerdown", onDown, { passive: true });
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("blur", onLeave);
    window.addEventListener("hashchange", wake);
    document.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    tg?.onEvent("deactivated", stop);
    tg?.onEvent("activated", wake);
    wake();
    return () => {
      stop();
      cancelAnimationFrame(resizeRaf);
      theme.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("hashchange", wake);
      document.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      tg?.offEvent("deactivated", stop);
      tg?.offEvent("activated", wake);
    };
  }, []);

  return (
    <div className="backdrop" aria-hidden>
      <canvas ref={ref} className="hex-canvas" />
      <div className="backdrop-vignette" />
    </div>
  );
}

/** The Skill Hive logo: an outlined hex with a filled cell inside (the landing's own polygons). */
export function HexMark({ size = 26, muted = false }: { size?: number; muted?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden className={muted ? "hex-mark muted" : "hex-mark"}>
      <polygon className="hex-rim" points="50,5 90,27.5 90,72.5 50,95 10,72.5 10,27.5" fill="none" strokeWidth="6" strokeLinejoin="round" />
      <polygon className="hex-core" points="50,26 71,38 71,62 50,74 29,62 29,38" opacity="0.92" />
    </svg>
  );
}
