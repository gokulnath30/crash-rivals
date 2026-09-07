import { modeLabel, type GameDefinition } from '@domain/catalog/game-definition.ts';
import { button, el, on } from '../dom.ts';

/** The shelf: one tile per game, filterable by tag. */
export function renderStore(props: {
  games: readonly GameDefinition[];
  tags: readonly string[];
  activeTag: string | null;
  onFilter: (tag: string | null) => void;
  onOpen: (game: GameDefinition) => void;
}): HTMLElement {
  const tag = props.activeTag;
  const shown = tag ? props.games.filter((game) => game.tags.includes(tag)) : props.games;

  const filters = el('div', { className: 'filters', attrs: { role: 'group', 'aria-label': 'Filter games' } }, [
    chip('Everything', props.activeTag === null, () => {
      props.onFilter(null);
    }),
    ...props.tags.map((tag) =>
      chip(tag, props.activeTag === tag, () => {
        props.onFilter(tag);
      }),
    ),
  ]);

  const shelf = el(
    'ul',
    { className: 'shelf' },
    shown.map((game) => tile(game, props.onOpen)),
  );

  return el('section', {}, [
    el('div', { className: 'section-head' }, [
      el('h2', { className: 'section-title', text: 'Pick a game' }),
      el('span', {
        className: 'muted',
        text: `${shown.length} of ${props.games.length}`,
      }),
    ]),
    filters,
    shown.length > 0
      ? shelf
      : el('p', { className: 'muted', text: 'Nothing on the shelf under that tag.' }),
  ]);
}

function chip(label: string, active: boolean, onClick: () => void): HTMLElement {
  const node = el('button', {
    className: `chip${active ? ' chip--on' : ''}`,
    text: label,
    attrs: { type: 'button', 'aria-pressed': String(active) },
  });
  node.addEventListener('click', onClick);
  return node;
}

function tile(game: GameDefinition, onOpen: (game: GameDefinition) => void): HTMLElement {
  const poster = el('div', { className: 'tile__poster' }, [
    el('span', { className: 'tile__badge', text: `${game.modes.length} way${game.modes.length === 1 ? '' : 's'} to play` }),
  ]);
  poster.style.background = game.art.poster;

  const open = (): void => {
    onOpen(game);
  };

  const card = el('article', { className: 'tile' }, [
    poster,
    el('div', { className: 'tile__body' }, [
      el('h3', { className: 'tile__title', text: game.title }),
      el('p', { className: 'tile__tagline', text: game.tagline }),
      el(
        'ul',
        { className: 'tile__modes' },
        game.modes.map((mode) => el('li', { text: modeLabel(game, mode) })),
      ),
      button({ label: 'Open', onClick: open }),
    ]),
  ]);
  card.style.setProperty('--accent', game.art.accent);
  card.style.setProperty('--accent-alt', game.art.accentAlt);

  // The whole tile is clickable, but the button is what assistive tech and the
  // keyboard reach — so the tile itself stays a plain article, not a fake one.
  on(poster, 'click', open);

  return el('li', {}, [card]);
}
