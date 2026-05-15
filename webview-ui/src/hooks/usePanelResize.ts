import { useEffect, useRef } from 'react';

interface Options {
  storageKey: string;
  defaultWidth?: number;
  min?: number;
  max?: number;
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

    // Restore persisted width — clamp only against absolute min/max, not parent
    // width, because the panel may be hidden (display:none) on mount and
    // parentElement.clientWidth would be 0, collapsing the list.
    const stored = localStorage.getItem(storageKey);
    const parsed = stored ? parseInt(stored, 10) : NaN;
    const initial = !isNaN(parsed) ? Math.max(min, Math.min(max, parsed)) : defaultWidth;
    applyListWidth(initial);

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = list.getBoundingClientRect().width;

      // Capture keeps pointermove/pointerup going even outside the VS Code window
      handle.setPointerCapture(e.pointerId);
      document.querySelector('.app')?.classList.add('panel-resizing');

      let dragActive = true;

      const clamp = (x: number) => clampListWidth(startWidth + x - startX);

      const persistCurrentWidth = () => {
        const finalWidth = clampListWidth(list.getBoundingClientRect().width);
        applyListWidth(finalWidth);
        localStorage.setItem(storageKey, String(finalWidth));
      };

      const onPointerMove = (ev: PointerEvent) => {
        applyListWidth(clamp(ev.clientX));
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
        applyListWidth(clamp(ev.clientX));
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
      if (!container || container.clientWidth === 0) return;
      const currentList = list.getBoundingClientRect().width;
      applyListWidth(clampListWidth(currentList));
    });
    if (container) observer.observe(container);

    return () => {
      handle.removeEventListener('pointerdown', onPointerDown);
      observer.disconnect();
    };
  }, [storageKey, defaultWidth, min, max]);

  return { listRef, handleRef };
}
