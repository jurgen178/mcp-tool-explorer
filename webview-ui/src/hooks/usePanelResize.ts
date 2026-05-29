import { useEffect, useRef } from 'react';

interface Options {
  storageKey: string;
  defaultWidth?: number;
  min?: number;
  max?: number;
}

function getInitialWidth(storageKey: string, defaultWidth: number, min: number, max: number) {
  const stored = localStorage.getItem(storageKey);
  const parsed = stored ? parseInt(stored, 10) : NaN;
  return Math.max(min, Math.min(max, !isNaN(parsed) ? parsed : defaultWidth));
}

/**
 * Panel-list resize via native pointerdown + pointer capture + document listeners.
 * setPointerCapture ensures pointerup fires even if the mouse leaves the VS Code window.
 */
export function usePanelResize({
  storageKey,
  defaultWidth = 260,
  min = 140,
  max = 600,
}: Options) {
  const listRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const MIN_DETAIL = 200;
  const HANDLE_W = 8;

  useEffect(() => {
    const list = listRef.current;
    const handle = handleRef.current;
    if (!list || !handle) return;

    const getMaxListWidth = () => list.parentElement
      ? Math.max(0, Math.min(max, list.parentElement.clientWidth - HANDLE_W - MIN_DETAIL))
      : max;

    const clampListWidth = (width: number, maxWidth = getMaxListWidth()) => {
      const safeMax = Math.max(0, maxWidth);
      const safeMin = Math.min(min, safeMax);
      return Math.max(safeMin, Math.min(safeMax, width));
    };

    const applyListWidth = (width: number) => {
      list.style.setProperty('--panel-list-width', `${width}px`);
    };

    const persistListWidth = (width: number) => {
      localStorage.setItem(storageKey, String(width));
    };

    const updateWidth = (width: number) => {
      applyListWidth(width);
      persistListWidth(width);
    };

    const restoreStoredWidth = () => {
      applyListWidth(getInitialWidth(storageKey, defaultWidth, min, max));
    };

    // Restore persisted width — clamp only against absolute min/max, not parent
    // width, because the panel may be hidden (display:none) on mount and
    // parentElement.clientWidth would be 0, collapsing the list.
    restoreStoredWidth();

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = list.getBoundingClientRect().width;

      // Capture keeps pointermove/pointerup going even outside the VS Code window
      handle.setPointerCapture(e.pointerId);
      document.querySelector('.app')?.classList.add('panel-resizing');

      let dragActive = true;
      let latestWidth = clampListWidth(startWidth);

      const clamp = (x: number) => clampListWidth(startWidth + x - startX);

      const persistCurrentWidth = () => {
        updateWidth(latestWidth);
      };

      const onPointerMove = (ev: PointerEvent) => {
        latestWidth = clamp(ev.clientX);
        updateWidth(latestWidth);
      };

      const cleanupDrag = (pointerId?: number) => {
        if (!dragActive) return;
        dragActive = false;
        document.querySelector('.app')?.classList.remove('panel-resizing');
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        handle.removeEventListener('pointercancel', onPointerCancel);
        handle.removeEventListener('lostpointercapture', onLostPointerCapture);
        if (pointerId !== undefined && handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
      };

      const onPointerUp = (ev: PointerEvent) => {
        latestWidth = clamp(ev.clientX);
        updateWidth(latestWidth);
        persistCurrentWidth();
        cleanupDrag(ev.pointerId);
      };

      const onPointerCancel = () => {
        persistCurrentWidth();
        cleanupDrag();
      };

      const onLostPointerCapture = () => {
        persistCurrentWidth();
        cleanupDrag();
      };

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      handle.addEventListener('pointercancel', onPointerCancel);
      handle.addEventListener('lostpointercapture', onLostPointerCapture);
    };

    handle.addEventListener('pointerdown', onPointerDown);

    // Clamp list width when the container shrinks (e.g. window un-maximized).
    // Skip when the container is hidden (clientWidth === 0) — e.g. when the
    // panel tab is inactive and its wrapper has display:none — otherwise the
    // ResizeObserver would clamp the stored width down to the minimum.
    const container = list.parentElement;
    const observer = new ResizeObserver(() => {
      if (!container || container.clientWidth === 0 || document.visibilityState !== 'visible') return;
      const storedWidth = getInitialWidth(storageKey, defaultWidth, min, max);
      applyListWidth(clampListWidth(storedWidth));
    });
    if (container) observer.observe(container);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        restoreStoredWidth();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      handle.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      observer.disconnect();
    };
  }, [storageKey, defaultWidth, min, max]);

  return { listRef, handleRef };
}
