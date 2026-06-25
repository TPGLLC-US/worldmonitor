import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { WatchlistTableView } from '../src/components/WatchlistTableView';

type Item = {
  symbol: string;
  rank: number;
};

type ViewState = {
  sort: string;
  filter: string;
  search: string;
  expandedKey: string | null;
  virtualStart: number;
  virtualScrollTop: number;
  expandedDetailHeight: number;
};

function createItems(count = 618): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    symbol: `SYM${String(index).padStart(3, '0')}`,
    rank: index,
  }));
}

function createView() {
  const view = new WatchlistTableView<Item>({
    columns: [
      { key: 'symbol', label: 'Symbol', sortable: true, sortOptionKey: 'symbol-asc', cell: (item) => item.symbol },
      { key: 'rank', label: 'Rank', sortable: true, sortOptionKey: 'rank-desc', align: 'right', cell: (item) => String(item.rank) },
    ],
    filters: [
      { key: 'all', label: 'All', match: () => true },
      { key: 'even', label: 'Even', match: (item) => item.rank % 2 === 0 },
    ],
    sortOptions: [
      { key: 'symbol-asc', label: 'Symbol A-Z', cmp: (a, b) => a.symbol.localeCompare(b.symbol) },
      { key: 'rank-desc', label: 'Rank down', cmp: (a, b) => b.rank - a.rank },
    ],
    defaultSort: 'symbol-asc',
    defaultFilter: 'all',
    getKey: (item) => item.symbol,
    getSearchText: (item) => item.symbol,
    renderDetail: (item) => `<section class="detail">Detail ${item.symbol}</section>`,
  });
  view.setItems(createItems());
  return view;
}

function stateOf(view: WatchlistTableView<Item>): ViewState {
  return (view as unknown as { state: ViewState }).state;
}

function countRows(html: string): number {
  return (html.match(/class="watchlist-row/g) || []).length;
}

describe('WatchlistTableView virtualization', () => {
  it('renders a small semantic window for the 618-row watchlist tbody', () => {
    const view = createView();
    const html = view.render();

    assert.equal(countRows(html), 44, 'only visible rows plus overscan should mount');
    assert.match(html, /data-watchlist-totalrows="618"/);
    assert.match(html, /data-watchlist-renderedrows="44"/);
    assert.match(html, /watchlist-virtual-spacer-bottom/);
    assert.match(html, /SYM000/);
    assert.match(html, /SYM043/);
    assert.doesNotMatch(html, /SYM044/);
    assert.doesNotMatch(html, /SYM617/);
  });

  it('keeps the full sorted list scrollable by shifting the virtual window', () => {
    const view = createView();
    stateOf(view).virtualStart = 200;
    stateOf(view).virtualScrollTop = 200 * 33;

    const html = view.render();

    assert.equal(countRows(html), 44);
    assert.match(html, /watchlist-virtual-spacer-top/);
    assert.match(html, /height:6600px/);
    assert.match(html, /SYM200/);
    assert.match(html, /SYM243/);
    assert.doesNotMatch(html, /SYM199/);
    assert.doesNotMatch(html, /SYM244/);
  });

  it('applies sort, filter, search, and expansion before choosing the visible window', () => {
    const view = createView();
    const state = stateOf(view);

    state.sort = 'rank-desc';
    let html = view.render();
    assert.match(html, /data-watchlist-totalrows="618"/);
    assert.ok(html.indexOf('SYM617') < html.indexOf('SYM574'), 'rank-desc drives the visible window order');

    state.filter = 'even';
    state.virtualStart = 0;
    html = view.render();
    assert.match(html, /data-watchlist-totalrows="309"/);
    assert.match(html, /SYM616/);
    assert.doesNotMatch(html, /SYM617/);

    state.filter = 'all';
    state.sort = 'symbol-asc';
    state.search = 'SYM61';
    state.virtualStart = 0;
    html = view.render();
    assert.match(html, /data-watchlist-totalrows="8"/);
    assert.equal(countRows(html), 8, 'small search result should not virtualize');
    assert.match(html, /SYM610/);
    assert.match(html, /SYM617/);

    state.search = '';
    state.expandedKey = 'SYM002';
    html = view.render();
    assert.match(html, /watchlist-detail-row/);
    assert.match(html, /Detail SYM002/);
  });

  it('carries measured expanded-detail height into spacer rows outside the rendered window', () => {
    const view = createView();
    const state = stateOf(view);
    state.expandedKey = 'SYM002';
    state.expandedDetailHeight = 240;
    state.virtualStart = 10;

    const html = view.render();

    assert.match(html, /watchlist-virtual-spacer-top/);
    assert.match(html, /height:570px/, 'top spacer includes 10 rows plus the measured expanded detail height');
    assert.doesNotMatch(html, /Detail SYM002/, 'off-window expanded detail should be represented by spacer height, not mounted');
  });

  it('does not resort the full list from the scroll handler', () => {
    const source = readFileSync(new URL('../src/components/WatchlistTableView.ts', import.meta.url), 'utf8');
    const scrollHandler = source.match(/scrollEl\.addEventListener\('scroll'[\s\S]*?\}, \{ passive: true \}\);/);

    assert.ok(scrollHandler, 'scroll handler should be present');
    assert.doesNotMatch(scrollHandler[0], /getFilteredSorted\(/);
    assert.match(scrollHandler[0], /dataset\.watchlistTotalrows/);
  });
});
