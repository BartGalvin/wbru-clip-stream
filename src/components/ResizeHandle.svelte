<script lang="ts">
  // A panel divider with pointer, keyboard, and double-click sizing.
  const {
    label,
    panelId,
    size,
    minSize,
    maxSize,
    defaultSize,
    orientation = 'vertical',
    class: className = '',
    reverse = false,
    onresize,
  }: {
    label: string;
    panelId: string;
    size: number;
    minSize: number;
    maxSize: number;
    defaultSize: number;
    orientation?: 'vertical' | 'horizontal';
    class?: string;
    reverse?: boolean;
    onresize: (size: number) => void;
  } = $props();

  let drag = $state<{ pointerId: number; startPosition: number; startSize: number } | null>(null);

  function resize(nextSize: number): void {
    onresize(Math.max(minSize, Math.min(maxSize, nextSize)));
  }

  const pointerPosition = (event: PointerEvent): number =>
    orientation === 'vertical' ? event.clientX : event.clientY;

  // Capture the pointer so resizing continues beyond the handle.
  function startDrag(event: PointerEvent & { currentTarget: HTMLDivElement }): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, startPosition: pointerPosition(event), startSize: size };
  }

  function dragPanel(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    resize(drag.startSize + (pointerPosition(event) - drag.startPosition) * (reverse ? -1 : 1));
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    const decreaseKey = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const increaseKey = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (event.key === decreaseKey || event.key === increaseKey) {
      const step = (event.key === increaseKey ? 16 : -16) * (reverse ? -1 : 1);
      resize(size + step);
    } else if (event.key === 'Home') resize(minSize);
    else if (event.key === 'End') resize(maxSize);
    else return;
    event.preventDefault();
  }
</script>

<!-- A focusable separator is an interactive window splitter. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class={`resize-handle ${className}`}
  class:dragging={drag !== null}
  role="separator"
  tabindex="0"
  aria-label={label}
  aria-controls={panelId}
  aria-orientation={orientation}
  aria-valuemin={minSize}
  aria-valuemax={maxSize}
  aria-valuenow={size}
  aria-valuetext={`${size} pixels`}
  title={label}
  onpointerdown={startDrag}
  onpointermove={dragPanel}
  onpointerup={() => (drag = null)}
  onpointercancel={() => (drag = null)}
  onlostpointercapture={() => (drag = null)}
  onkeydown={resizeWithKeyboard}
  ondblclick={() => resize(defaultSize)}
></div>
