<script lang="ts">
  // Resize a panel from either edge; reverse makes dragging left increase its width.
  const {
    label,
    panelId,
    width,
    minWidth,
    maxWidth,
    defaultWidth,
    reverse = false,
    onresize,
  }: {
    label: string;
    panelId: string;
    width: number;
    minWidth: number;
    maxWidth: number;
    defaultWidth: number;
    reverse?: boolean;
    onresize: (width: number) => void;
  } = $props();

  let drag = $state<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  function resize(nextWidth: number): void {
    onresize(Math.max(minWidth, Math.min(maxWidth, nextWidth)));
  }

  // Capture the pointer so dragging continues outside the corner grip.
  function startDrag(event: PointerEvent & { currentTarget: HTMLDivElement }): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
  }

  function dragColumn(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    resize(drag.startWidth + (event.clientX - drag.startX) * (reverse ? -1 : 1));
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const step = (event.key === 'ArrowRight' ? 16 : -16) * (reverse ? -1 : 1);
      resize(width + step);
    } else if (event.key === 'Home') resize(minWidth);
    else if (event.key === 'End') resize(maxWidth);
    else return;
    event.preventDefault();
  }
</script>

<!-- A focusable separator is an interactive window splitter. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="resize-handle"
  class:dragging={drag !== null}
  class:sidebar-resize-handle={!reverse}
  role="separator"
  tabindex="0"
  aria-label={label}
  aria-controls={panelId}
  aria-orientation="vertical"
  aria-valuemin={minWidth}
  aria-valuemax={maxWidth}
  aria-valuenow={width}
  aria-valuetext={`${width} pixels`}
  title={label}
  onpointerdown={startDrag}
  onpointermove={dragColumn}
  onpointerup={() => (drag = null)}
  onpointercancel={() => (drag = null)}
  onlostpointercapture={() => (drag = null)}
  onkeydown={resizeWithKeyboard}
  ondblclick={() => resize(defaultWidth)}
></div>
