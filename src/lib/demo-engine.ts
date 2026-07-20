// ─── Client-side live-demo engine ─────────────────────────────────────────
// Framework-free renderer for the module demos. Reads a DemoConfig (embedded
// as JSON in the page) and mounts an interactive, seeded mock application.
// No network, no backend — every interaction runs in the browser.

import type { DemoConfig, Tab } from '../data/demos';

type AnyRow = Record<string, any>;

// ── tiny DOM helper ────────────────────────────────────────────────────────
function el(tag: string, props: Record<string, any> = {}, children: (Node | string)[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

// ── formatting ───────────────────────────────────────────────────────────
function eur(n: number): string {
  return '€ ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── status → colour bucket ─────────────────────────────────────────────────
const GREEN = ['delivered', 'paid', 'accepted', 'approved', 'ordered', 'active', 'won', 'resolved', 'met', 'ok', 'owner'];
const AMBER = ['shipped', 'sent', 'submitted', 'pending', 'trial', 'low', 'at-risk', 'under_review', 'editor', 'high', 'confirmed'];
const RED = ['overdue', 'out', 'lost', 'breached', 'offboarded', 'rejected', 'expired', 'urgent'];

function badge(value: string): HTMLElement {
  const key = String(value).toLowerCase();
  let mod = 'neutral';
  if (GREEN.includes(key)) mod = 'ok';
  else if (AMBER.includes(key)) mod = 'warn';
  else if (RED.includes(key)) mod = 'bad';
  const label = String(value).replace(/_/g, ' ');
  return el('span', { class: `d-badge d-badge--${mod}` }, [label]);
}

// ── line-item totals ───────────────────────────────────────────────────────
function linesTable(lines: { desc: string; qty: number; price: number; vat?: number }[]): HTMLElement {
  const hasVat = lines.some((l) => l.vat !== undefined);
  const body = lines.map((l) =>
    el('div', { class: 'd-line' }, [
      el('span', { class: 'd-line__desc' }, [l.desc]),
      el('span', { class: 'd-line__qty' }, [`${l.qty} ×`]),
      el('span', { class: 'd-line__price' }, [eur(l.price)]),
      el('span', { class: 'd-line__amt' }, [eur(l.qty * l.price)]),
    ]),
  );
  const net = lines.reduce((s, l) => s + l.qty * l.price, 0);
  const foot: HTMLElement[] = [];
  if (hasVat) {
    const vat = lines.reduce((s, l) => s + l.qty * l.price * (l.vat ?? 0) / 100, 0);
    foot.push(totalRow('Net', eur(net)));
    foot.push(totalRow('VAT', eur(vat)));
    foot.push(totalRow('Gross', eur(net + vat), true));
  } else {
    foot.push(totalRow('Total', eur(net), true));
  }
  return el('div', { class: 'd-lines' }, [...body, el('div', { class: 'd-lines__foot' }, foot)]);
}

function totalRow(label: string, value: string, strong = false): HTMLElement {
  return el('div', { class: `d-total${strong ? ' d-total--strong' : ''}` }, [
    el('span', {}, [label]), el('span', {}, [value]),
  ]);
}

function timeline(events: { label: string; at: string; done?: boolean }[]): HTMLElement {
  return el('div', { class: 'd-timeline' }, events.map((e) =>
    el('div', { class: `d-tl${e.done === false ? ' d-tl--pending' : ''}` }, [
      el('span', { class: 'd-tl__dot' }),
      el('span', { class: 'd-tl__label' }, [e.label]),
      el('span', { class: 'd-tl__at' }, [e.at]),
    ]),
  ));
}

// ── detail drawer ───────────────────────────────────────────────────────────
function openDrawer(root: HTMLElement, title: string, sections: Node[]) {
  root.querySelector('.d-drawer')?.remove();
  const panel = el('aside', { class: 'd-drawer', role: 'dialog', 'aria-label': title }, [
    el('div', { class: 'd-drawer__head' }, [
      el('span', { class: 'd-drawer__title' }, [title]),
      el('button', { class: 'd-drawer__close', 'aria-label': 'Close', onclick: () => panel.remove() }, ['✕']),
    ]),
    el('div', { class: 'd-drawer__body' }, sections),
  ]);
  root.append(panel);
}

// ── LIST view ───────────────────────────────────────────────────────────────
function renderList(tab: Extract<Tab, { type: 'list' }>, root: HTMLElement): HTMLElement {
  const wrap = el('div', { class: 'd-view' });
  const state = { q: '', filter: '', selected: new Set<number>() };

  const toolbar = el('div', { class: 'd-toolbar' });
  if (tab.search) {
    toolbar.append(el('input', {
      class: 'd-search', type: 'search', placeholder: 'Search…', 'aria-label': 'Search',
      oninput: (e: Event) => { state.q = (e.target as HTMLInputElement).value.toLowerCase(); draw(); },
    }));
  }
  if (tab.filters) {
    const chips = el('div', { class: 'd-chips' }, tab.filters.map((f) =>
      el('button', {
        class: 'd-chip' + (f.value === '' ? ' d-chip--on' : ''), 'data-v': f.value,
        onclick: (e: Event) => {
          state.filter = f.value;
          chips.querySelectorAll('.d-chip').forEach((c) => c.classList.remove('d-chip--on'));
          (e.target as HTMLElement).classList.add('d-chip--on');
          draw();
        },
      }, [f.label]),
    ));
    toolbar.append(chips);
  }
  wrap.append(toolbar);

  const bulkBar = tab.bulk ? el('div', { class: 'd-bulkbar', hidden: 'true' }) : null;
  if (bulkBar) wrap.append(bulkBar);

  const table = el('div', { class: 'd-table' });
  wrap.append(table);

  function draw() {
    table.innerHTML = '';
    const gridCols = (tab.bulk ? '36px ' : '') + tab.columns.map((c) => c.cls === 'num' ? '0.7fr' : '1fr').join(' ');
    const header = el('div', { class: 'd-tr d-tr--head' });
    header.style.gridTemplateColumns = gridCols;
    if (tab.bulk) header.append(el('span'));
    tab.columns.forEach((c) => header.append(el('span', { class: 'd-th' + (c.cls === 'num' ? ' d-th--num' : '') }, [c.label])));
    table.append(header);

    const rows = tab.rows.filter((r) => {
      if (tab.filterKey && state.filter && String(r[tab.filterKey]) !== state.filter) return false;
      if (state.q && tab.searchKeys) {
        return tab.searchKeys.some((k) => String(r[k] ?? '').toLowerCase().includes(state.q));
      }
      return true;
    });

    if (rows.length === 0) {
      table.append(el('div', { class: 'd-empty' }, ['No matching records.']));
    }

    rows.forEach((r) => {
      const idx = tab.rows.indexOf(r);
      const tr = el('div', { class: 'd-tr' + (tab.detail ? ' d-tr--click' : '') });
      tr.style.gridTemplateColumns = gridCols;
      if (tab.bulk) {
        const cb = el('input', { type: 'checkbox', 'aria-label': 'Select row' }) as HTMLInputElement;
        cb.checked = state.selected.has(idx);
        cb.addEventListener('change', () => {
          cb.checked ? state.selected.add(idx) : state.selected.delete(idx);
          syncBulk();
        });
        tr.append(el('span', { class: 'd-cell' }, [cb]));
      }
      tab.columns.forEach((c) => {
        const raw = r[c.key];
        if (c.status) tr.append(el('span', { class: 'd-cell' }, [badge(raw)]));
        else tr.append(el('span', { class: 'd-cell d-cell--' + (c.cls ?? 'text') }, [String(raw ?? '')]));
      });
      if (tab.detail) {
        tr.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).tagName === 'INPUT') return;
          showDetail(r);
        });
      }
      table.append(tr);
    });
  }

  function syncBulk() {
    if (!bulkBar) return;
    const n = state.selected.size;
    bulkBar.hidden = n === 0;
    bulkBar.innerHTML = '';
    bulkBar.append(
      el('span', { class: 'd-bulkbar__count' }, [`${n} selected`]),
      el('button', { class: 'd-btn d-btn--sm', onclick: () => flash(bulkBar, 'Archived ' + n) }, ['Archive']),
      el('button', { class: 'd-btn d-btn--sm', onclick: () => flash(bulkBar, 'Exported ' + n + ' rows to CSV') }, ['Export CSV']),
      el('button', { class: 'd-btn d-btn--sm d-btn--ghost', onclick: () => { state.selected.clear(); draw(); syncBulk(); } }, ['Clear']),
    );
  }

  function showDetail(r: AnyRow) {
    const d = tab.detail!;
    const sections: Node[] = [];
    for (const s of d.sections) {
      sections.push(el('div', { class: 'd-sec__title' }, [s.title]));
      if (s.kind === 'fields') {
        sections.push(el('div', { class: 'd-fields' }, s.fields.map((f) =>
          el('div', { class: 'd-field' }, [ el('dt', {}, [f.label]), el('dd', {}, [String(r[f.key] ?? '—')]) ]),
        )));
      } else if (s.kind === 'timeline') {
        sections.push(timeline(r[s.key] ?? []));
      } else if (s.kind === 'lines') {
        sections.push(linesTable(r[s.key] ?? []));
      } else if (s.kind === 'note') {
        sections.push(el('p', { class: 'd-note' }, [String(r[s.key] ?? '')]));
      }
    }
    openDrawer(root, String(r[d.titleKey]), sections);
  }

  draw();
  return wrap;
}

function flash(bar: HTMLElement, msg: string) {
  const t = el('span', { class: 'd-flash' }, [msg]);
  bar.append(t);
  setTimeout(() => t.remove(), 1600);
}

// ── BOARD view (kanban) ──────────────────────────────────────────────────────
function renderBoard(tab: Extract<Tab, { type: 'board' }>): HTMLElement {
  const wrap = el('div', { class: 'd-view' });
  wrap.append(el('p', { class: 'd-hint' }, ['Click a deal card to advance it to the next stage. Won and lost are terminal.']));
  const board = el('div', { class: 'd-board' });
  wrap.append(board);
  const cards = tab.cards.map((c) => ({ ...c }));
  const order = tab.stages.map((s) => s.id);

  function advance(id: string) {
    const card = cards.find((c) => c.id === id)!;
    const stage = tab.stages.find((s) => s.id === card.stage)!;
    if (stage.terminal) return;
    const i = order.indexOf(card.stage);
    // move to next non-terminal working stage, or to "won" when leaving proposal
    const next = order[i + 1];
    card.stage = next ?? card.stage;
    draw();
  }

  function draw() {
    board.innerHTML = '';
    board.style.gridTemplateColumns = `repeat(${tab.stages.length}, minmax(160px, 1fr))`;
    tab.stages.forEach((s) => {
      const colCards = cards.filter((c) => c.stage === s.id);
      const sum = colCards.reduce((n, c) => n + (parseInt((c.value ?? '0').replace(/[^\d]/g, '')) || 0), 0);
      const col = el('div', { class: 'd-col' }, [
        el('div', { class: 'd-col__head' }, [
          el('span', { class: 'd-col__label' }, [s.label]),
          el('span', { class: 'd-col__count' }, [String(colCards.length)]),
        ]),
        el('div', { class: 'd-col__sum' }, [sum ? eur(sum) : '—']),
      ]);
      colCards.forEach((c) => {
        col.append(el('div', {
          class: 'd-card' + (s.terminal ? ' d-card--done' : ' d-card--click'),
          onclick: () => advance(c.id),
        }, [
          el('span', { class: 'd-card__title' }, [c.title]),
          el('span', { class: 'd-card__sub' }, [c.sub]),
          c.value ? el('span', { class: 'd-card__val' }, [c.value]) : el('span'),
        ]));
      });
      board.append(col);
    });
  }
  draw();
  return wrap;
}

// ── CATALOG view (storefront) ────────────────────────────────────────────────
function renderCatalog(tab: Extract<Tab, { type: 'catalog' }>, updateStat: StatUpdater): HTMLElement {
  const wrap = el('div', { class: 'd-view d-shop' });
  const cart = new Map<string, number>();
  const grid = el('div', { class: 'd-grid' });
  const side = el('aside', { class: 'd-cart' });
  wrap.append(grid, side);

  function add(id: string) {
    const p = tab.products.find((x) => x.id === id)!;
    const inCart = cart.get(id) ?? 0;
    if (inCart >= p.stock) return;
    cart.set(id, inCart + 1);
    drawCart();
  }
  function setQty(id: string, q: number) {
    if (q <= 0) cart.delete(id); else cart.set(id, q);
    drawCart();
  }

  tab.products.forEach((p) => {
    grid.append(el('div', { class: 'd-prod' }, [
      el('div', { class: 'd-prod__cat' }, [p.cat]),
      el('div', { class: 'd-prod__name' }, [p.name]),
      el('div', { class: 'd-prod__sku' }, [p.sku]),
      el('div', { class: 'd-prod__row' }, [
        el('span', { class: 'd-prod__price' }, [eur(p.price)]),
        el('span', { class: 'd-prod__stock' + (p.stock <= 5 ? ' d-prod__stock--low' : '') }, [`${p.stock} in stock`]),
      ]),
      el('button', { class: 'd-btn d-btn--sm', onclick: () => add(p.id) }, ['Add to cart']),
    ]));
  });

  function syncStats(count: number, gross: number) {
    updateStat('cartCount', String(count));
    updateStat('cartTotal', eur(gross));
  }

  function drawCart() {
    side.innerHTML = '';
    side.append(el('div', { class: 'd-cart__head' }, ['Cart']));
    if (cart.size === 0) {
      side.append(el('p', { class: 'd-cart__empty' }, ['Your cart is empty.']));
      syncStats(0, 0);
      return;
    }
    let net = 0;
    let count = 0;
    cart.forEach((qty, id) => {
      const p = tab.products.find((x) => x.id === id)!;
      const amt = p.price * qty;
      net += amt;
      count += qty;
      side.append(el('div', { class: 'd-cart__line' }, [
        el('span', { class: 'd-cart__name' }, [p.name]),
        el('span', { class: 'd-cart__qty' }, [
          el('button', { class: 'd-step', 'aria-label': 'Decrease', onclick: () => setQty(id, qty - 1) }, ['−']),
          el('span', {}, [String(qty)]),
          el('button', { class: 'd-step', 'aria-label': 'Increase', onclick: () => setQty(id, Math.min(qty + 1, p.stock)) }, ['+']),
        ]),
        el('span', { class: 'd-cart__amt' }, [eur(amt)]),
      ]));
    });
    const vat = net * 0.20;
    syncStats(count, net + vat);
    side.append(el('div', { class: 'd-cart__foot' }, [
      totalRow('Net', eur(net)),
      totalRow('VAT 20%', eur(vat)),
      totalRow('Gross', eur(net + vat), true),
    ]));
    const co = el('button', { class: 'd-btn', onclick: () => {
      co.textContent = '✓ Order placed';
      co.classList.add('d-btn--ok');
      setTimeout(() => { cart.clear(); drawCart(); }, 1400);
    } }, ['Checkout →']);
    side.append(co);
  }
  drawCart();
  return wrap;
}

// ── REPORT view ──────────────────────────────────────────────────────────────
function renderReport(tab: Extract<Tab, { type: 'report' }>): HTMLElement {
  const wrap = el('div', { class: 'd-view' });
  let active = tab.metrics[0].id;
  const tabs = el('div', { class: 'd-chips' }, tab.metrics.map((m) =>
    el('button', { class: 'd-chip' + (m.id === active ? ' d-chip--on' : ''), onclick: (e: Event) => {
      active = m.id;
      tabs.querySelectorAll('.d-chip').forEach((c) => c.classList.remove('d-chip--on'));
      (e.target as HTMLElement).classList.add('d-chip--on');
      draw();
    } }, [m.label]),
  ));
  const chartBox = el('div', { class: 'd-chart' });
  const pivot = el('div', { class: 'd-pivot' });
  wrap.append(tabs, chartBox, pivot);

  function draw() {
    const m = tab.metrics.find((x) => x.id === active)!;
    const max = Math.max(...m.series.map((s) => s.value));
    chartBox.innerHTML = '';
    const bars = el('div', { class: 'd-bars' }, m.series.map((s) =>
      el('div', { class: 'd-bar' }, [
        el('div', { class: 'd-bar__col' }, [
          el('div', { class: 'd-bar__fill', style: `height:${Math.max(4, (s.value / max) * 100)}%` }, [
            el('span', { class: 'd-bar__val' }, [String(s.value)]),
          ]),
        ]),
        el('span', { class: 'd-bar__label' }, [s.label]),
      ]),
    ));
    chartBox.append(bars);
    const total = m.series.reduce((n, s) => n + s.value, 0);
    pivot.innerHTML = '';
    pivot.append(
      el('div', { class: 'd-pivot__row d-pivot__row--head' }, [ el('span', {}, [m.label]), el('span', {}, [m.unit || 'value']), el('span', {}, ['% of total']) ]),
      ...m.series.map((s) => el('div', { class: 'd-pivot__row' }, [
        el('span', {}, [s.label]),
        el('span', { class: 'd-cell--num' }, [String(s.value)]),
        el('span', { class: 'd-cell--num' }, [`${Math.round((s.value / total) * 100)}%`]),
      ])),
      el('div', { class: 'd-pivot__row d-pivot__row--total' }, [ el('span', {}, ['Total']), el('span', { class: 'd-cell--num' }, [String(total)]), el('span', { class: 'd-cell--num' }, ['100%']) ]),
    );
  }
  draw();
  return wrap;
}

// ── TIMESHEET view ───────────────────────────────────────────────────────────
function renderTimesheet(tab: Extract<Tab, { type: 'timesheet' }>): HTMLElement {
  const wrap = el('div', { class: 'd-view' });
  let status = 'draft';
  const head = el('div', { class: 'd-ts__head' }, [ el('span', { class: 'd-ts__week' }, [tab.week]), el('span', { class: 'd-ts__status' }) ]);
  const grid = el('div', { class: 'd-ts' });
  const actions = el('div', { class: 'd-ts__actions' });
  wrap.append(head, grid, actions);

  const fmtH = (min: number) => (min / 60).toFixed(min % 60 === 0 ? 0 : 1) + 'h';

  function draw() {
    (head.querySelector('.d-ts__status') as HTMLElement).replaceChildren(badge(status));
    grid.innerHTML = '';
    const cols = `1.4fr repeat(${tab.days.length}, 0.6fr) 0.8fr`;
    const header = el('div', { class: 'd-ts__row d-ts__row--head' });
    header.style.gridTemplateColumns = cols;
    header.append(el('span', {}, ['Project']));
    tab.days.forEach((d) => header.append(el('span', { class: 'd-cell--num' }, [d])));
    header.append(el('span', { class: 'd-cell--num' }, ['Total']));
    grid.append(header);

    const dayTotals = tab.days.map(() => 0);
    let weekBillable = 0;
    tab.projects.forEach((p) => {
      const row = el('div', { class: 'd-ts__row' });
      row.style.gridTemplateColumns = cols;
      row.append(el('span', { class: 'd-ts__proj' }, [ p.name, el('span', { class: 'd-ts__rate' }, [p.rateEur ? eur(p.rateEur) + '/h' : 'non-billable']) ]));
      let rowMin = 0;
      p.minutes.forEach((min, i) => {
        rowMin += min; dayTotals[i] += min;
        row.append(el('span', { class: 'd-cell--num' + (min === 0 ? ' d-ts__zero' : '') }, [min ? fmtH(min) : '·']));
      });
      weekBillable += Math.round(rowMin * p.rateEur / 60);
      row.append(el('span', { class: 'd-cell--num d-ts__rowtot' }, [fmtH(rowMin)]));
      grid.append(row);
    });

    const foot = el('div', { class: 'd-ts__row d-ts__row--foot' });
    foot.style.gridTemplateColumns = cols;
    foot.append(el('span', {}, ['Daily total']));
    dayTotals.forEach((m) => foot.append(el('span', { class: 'd-cell--num' }, [fmtH(m)])));
    const weekMin = dayTotals.reduce((a, b) => a + b, 0);
    foot.append(el('span', { class: 'd-cell--num d-ts__rowtot' }, [fmtH(weekMin)]));
    grid.append(foot);

    actions.innerHTML = '';
    actions.append(el('span', { class: 'd-ts__billable' }, [`Billable this week: ${eur(weekBillable)}`]));
    if (status === 'draft') {
      actions.append(el('button', { class: 'd-btn d-btn--sm', onclick: () => { status = 'submitted'; draw(); } }, ['Submit week']));
    } else if (status === 'submitted') {
      actions.append(
        el('button', { class: 'd-btn d-btn--sm', onclick: () => { status = 'approved'; draw(); } }, ['Approve']),
        el('button', { class: 'd-btn d-btn--sm d-btn--ghost', onclick: () => { status = 'draft'; draw(); } }, ['Reject']),
      );
    } else {
      actions.append(el('span', { class: 'd-ts__locked' }, ['🔒 Approved weeks are locked']));
    }
  }
  draw();
  return wrap;
}

// ── TREE view (org chart) ────────────────────────────────────────────────────
function renderTree(tab: Extract<Tab, { type: 'tree' }>): HTMLElement {
  const wrap = el('div', { class: 'd-view d-tree' });
  const byParent = new Map<string | null, typeof tab.nodes>();
  tab.nodes.forEach((n) => {
    const arr = byParent.get(n.managerId) ?? [];
    arr.push(n); byParent.set(n.managerId, arr);
  });
  function node(n: typeof tab.nodes[number], depth: number): HTMLElement {
    const kids = byParent.get(n.id) ?? [];
    return el('div', { class: 'd-node', style: `margin-left:${depth * 22}px` }, [
      el('div', { class: 'd-node__box' }, [
        el('span', { class: 'd-node__name' }, [n.name]),
        el('span', { class: 'd-node__role' }, [`${n.role} · ${n.dept}`]),
      ]),
      ...kids.map((k) => node(k, depth + 1)),
    ]);
  }
  (byParent.get(null) ?? []).forEach((r) => wrap.append(node(r, 0)));
  return wrap;
}

// ── BUILDER view (offer editor) ──────────────────────────────────────────────
function renderBuilder(tab: Extract<Tab, { type: 'builder' }>): HTMLElement {
  const wrap = el('div', { class: 'd-view d-builder' });
  const lines = tab.lines.map((l) => ({ ...l, discount: l.discount ?? 0 }));

  const meta = el('div', { class: 'd-builder__meta' }, [
    el('div', { class: 'd-field' }, [ el('dt', {}, ['Customer']), el('dd', {}, [tab.customer]) ]),
    el('div', { class: 'd-field' }, [ el('dt', {}, ['Title']), el('dd', {}, [tab.title]) ]),
    el('div', { class: 'd-field' }, [ el('dt', {}, ['VAT']), el('dd', {}, [tab.vat + ' %']) ]),
  ]);
  const list = el('div', { class: 'd-builder__lines' });
  const totals = el('div', { class: 'd-builder__totals' });
  const addBtn = el('button', { class: 'd-btn d-btn--sm d-btn--ghost', onclick: () => { lines.push({ desc: 'New line item', qty: 1, price: 500, discount: 0 }); draw(); } }, ['+ Add line']);
  wrap.append(meta, list, addBtn, totals);

  function draw() {
    list.innerHTML = '';
    const header = el('div', { class: 'd-bl d-bl--head' }, [
      el('span', {}, ['Description']), el('span', { class: 'd-cell--num' }, ['Qty']),
      el('span', { class: 'd-cell--num' }, ['Unit €']), el('span', { class: 'd-cell--num' }, ['Disc %']),
      el('span', { class: 'd-cell--num' }, ['Amount']), el('span', {}),
    ]);
    list.append(header);
    let net = 0;
    lines.forEach((l, i) => {
      const amt = l.qty * l.price * (1 - l.discount / 100);
      net += amt;
      const qi = el('input', { class: 'd-num', type: 'number', min: '0', value: String(l.qty), 'aria-label': 'Quantity' }) as HTMLInputElement;
      qi.addEventListener('input', () => { l.qty = Math.max(0, parseInt(qi.value) || 0); draw(); });
      const pi = el('input', { class: 'd-num', type: 'number', min: '0', value: String(l.price), 'aria-label': 'Unit price' }) as HTMLInputElement;
      pi.addEventListener('input', () => { l.price = Math.max(0, parseFloat(pi.value) || 0); draw(); });
      const di = el('input', { class: 'd-num', type: 'number', min: '0', max: '100', value: String(l.discount), 'aria-label': 'Discount' }) as HTMLInputElement;
      di.addEventListener('input', () => { l.discount = Math.min(100, Math.max(0, parseInt(di.value) || 0)); draw(); });
      list.append(el('div', { class: 'd-bl' }, [
        el('span', { class: 'd-bl__desc' }, [l.desc]),
        el('span', { class: 'd-cell--num' }, [qi]),
        el('span', { class: 'd-cell--num' }, [pi]),
        el('span', { class: 'd-cell--num' }, [di]),
        el('span', { class: 'd-cell--num d-bl__amt' }, [eur(amt)]),
        el('button', { class: 'd-bl__del', 'aria-label': 'Remove line', onclick: () => { lines.splice(i, 1); draw(); } }, ['✕']),
      ]));
    });
    const vat = net * tab.vat / 100;
    totals.innerHTML = '';
    totals.append(totalRow('Net', eur(net)), totalRow(`VAT ${tab.vat}%`, eur(vat)), totalRow('Gross', eur(net + vat), true));
  }
  draw();
  return wrap;
}

// ── dispatcher ───────────────────────────────────────────────────────────────
type StatUpdater = (id: string, value: string) => void;

function renderTab(tab: Tab, root: HTMLElement, updateStat: StatUpdater): HTMLElement {
  switch (tab.type) {
    case 'list': return renderList(tab, root);
    case 'board': return renderBoard(tab);
    case 'catalog': return renderCatalog(tab, updateStat);
    case 'report': return renderReport(tab);
    case 'timesheet': return renderTimesheet(tab);
    case 'tree': return renderTree(tab);
    case 'builder': return renderBuilder(tab);
  }
}

export function mountDemo(root: HTMLElement, config: DemoConfig) {
  root.innerHTML = '';

  // Stats row — keep a reference to any stat that carries an id so views can
  // push live updates into it (e.g. the storefront cart count / total).
  const statRefs: Record<string, HTMLElement> = {};
  root.append(el('div', { class: 'd-stats' }, config.stats.map((s) => {
    const valueEl = el('div', { class: 'd-stat__value' }, [s.value]);
    if (s.id) statRefs[s.id] = valueEl;
    return el('div', { class: 'd-stat' }, [
      valueEl,
      el('div', { class: 'd-stat__label' }, [s.label + (s.sub ? ' ' + s.sub : '')]),
    ]);
  })));
  const updateStat: StatUpdater = (id, value) => {
    if (statRefs[id]) statRefs[id].textContent = value;
  };

  const app = el('div', { class: 'd-app' });
  root.append(app);

  // Tab bar (only if >1 tab)
  const panel = el('div', { class: 'd-panel' });
  if (config.tabs.length > 1) {
    const bar = el('div', { class: 'd-tabs' }, config.tabs.map((t, i) =>
      el('button', { class: 'd-tab' + (i === 0 ? ' d-tab--on' : ''), 'data-id': t.id, onclick: (e: Event) => {
        bar.querySelectorAll('.d-tab').forEach((b) => b.classList.remove('d-tab--on'));
        (e.target as HTMLElement).classList.add('d-tab--on');
        panel.innerHTML = '';
        panel.append(renderTab(t, panel, updateStat));
      } }, [t.label]),
    ));
    app.append(bar);
  }
  app.append(panel);
  panel.append(renderTab(config.tabs[0], panel, updateStat));
}
