// Native lightboxes use the same cancel path for Escape and outside clicks.
let startedOutside: HTMLDialogElement | null = null;
const outside = (event: PointerEvent, dialog: HTMLDialogElement) => {
  const r = dialog.getBoundingClientRect();
  return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
};
document.addEventListener('pointerdown', event => {
  const target = event.target;
  startedOutside = target instanceof HTMLDialogElement && target.open && outside(event, target) ? target : null;
});
document.addEventListener('pointerup', event => {
  const dialog = startedOutside; startedOutside = null;
  if (!dialog || event.target !== dialog || !outside(event, dialog)) return;
  // Existing cancel handlers retain busy guards, unsaved-change review and React state.
  const cancel = new Event('cancel', { cancelable: true });
  if (dialog.dispatchEvent(cancel)) dialog.close();
});
