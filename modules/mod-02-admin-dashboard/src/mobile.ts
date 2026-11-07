/**
 * Tables as cards on a phone — copy-in, byte-identical in every module with
 * the shared layout (docs/MOBILE-PLAN.md, M4). src/mobile.css lays a table
 * out as one card per row; this writes each cell's column name onto it
 * (`data-label`), from the table's header row, so the card says what every
 * value is. It watches the page, so tables React draws later are labelled
 * too, and it never touches a table marked `data-mobile="grid"` (a grid that
 * must stay one) or a cell that was labelled by hand.
 *
 * No framework and no state: it only reads the header text and sets an
 * attribute, and on a desktop the attribute is simply unused.
 */

function headersOf(table: HTMLTableElement): string[] {
  const row = table.tHead?.rows[0];
  if (!row) return [];
  const names: string[] = [];
  for (const cell of Array.from(row.cells)) {
    const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < cell.colSpan; i++) names.push(text);
  }
  return names;
}

function label(table: HTMLTableElement): void {
  if (table.dataset.mobile === 'grid') return;
  const names = headersOf(table);
  if (names.length === 0) return;
  table.classList.add('table--cards');
  for (const body of Array.from(table.tBodies)) {
    for (const row of Array.from(body.rows)) {
      let col = 0;
      for (const cell of Array.from(row.cells)) {
        if (!cell.hasAttribute('data-label')) cell.setAttribute('data-label', names[col] ?? '');
        col += cell.colSpan;
      }
    }
  }
}

let queued = false;

function labelAll(): void {
  queued = false;
  document.querySelectorAll('table').forEach((t) => label(t as HTMLTableElement));
}

/** Start labelling; call once, after the app has mounted. */
export function installMobileTables(): void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  labelAll();
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(labelAll);
  }).observe(document.body, { childList: true, subtree: true });
}
