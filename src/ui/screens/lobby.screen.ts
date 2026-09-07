import type { GameDefinition } from '@domain/catalog/game-definition.ts';
import type { Match } from '@domain/lobby/match.ts';
import type { RosterEntry } from '@app/usecases/pairing.usecase.ts';
import { button, el } from '../dom.ts';

/**
 * The waiting room.
 *
 * The code is the largest thing on the screen because reading it out is the
 * most common way it gets shared, and the link is a one-tap share because it
 * is the second. Below it, who is actually here.
 *
 * Both the host and the guests see this screen. It is the same room from two
 * sides, so it is the same view: only the start button differs, because only
 * the host has one.
 */
export function renderLobby(props: {
  game: GameDefinition;
  match: Match;
  inviteUrl: string;
  roster: readonly RosterEntry[];
  capacity: number;
  canStart: boolean;
  note: string;
  failed: boolean;
  onShare: () => void;
  onCopy: () => void;
  onStart: () => void;
  onCancel: () => void;
  shareNote: string | null;
  /** Host sees "Close the room"; a guest only leaves it. */
  isHost: boolean;
}): HTMLElement {
  const filled = props.roster.length;

  const children: HTMLElement[] = [
    el('p', {
      className: 'muted',
      text: `${props.game.title} · room code · ${String(filled)} of ${String(props.capacity)} seats`,
    }),
    // Letter-spaced and huge; the aria-label reads it as separate characters
    // so a screen reader does not pronounce it as a word.
    el('div', {
      className: 'code-display',
      text: props.match.code,
      attrs: { 'aria-label': `Room code ${props.match.code.split('').join(' ')}` },
    }),
    renderRoster(props.roster, props.capacity),
    el('p', {
      className: props.failed ? 'notice notice--error' : 'lead',
      text: props.note,
      attrs: { role: 'status' },
    }),
  ];

  const actions: HTMLElement[] = [];
  if (props.canStart) {
    // Start is the primary action once it exists, so sharing steps down to a
    // quieter button rather than competing with it.
    actions.push(button({ label: 'Start the match', onClick: props.onStart }));
    actions.push(button({ label: 'Send the link', tone: 'ghost', onClick: props.onShare }));
  } else {
    actions.push(button({ label: 'Send the link', onClick: props.onShare }));
  }
  actions.push(
    button({ label: 'Copy the link', tone: 'ghost', onClick: props.onCopy }),
    button({
      label: props.isHost ? 'Close the room' : 'Leave the room',
      tone: 'danger',
      onClick: props.onCancel,
    }),
  );
  children.push(el('div', { className: 'row row--wrap' }, actions));

  if (props.shareNote) {
    children.push(el('p', { className: 'muted', text: props.shareNote, attrs: { role: 'status' } }));
  }

  children.push(
    el('p', { className: 'link-preview', text: props.inviteUrl }),
    el('p', {
      className: 'hero__fine',
      text:
        `Only people with this code can play in this room. Once the match starts, it runs ` +
        `directly between your browsers — nothing goes through a server.`,
    }),
  );

  return el('section', { className: 'stack stack--centre' }, children);
}

/**
 * Who is here, and who is still an empty chair.
 *
 * Empty seats are drawn rather than omitted: a room that shows three names out
 * of four tells the host they can still wait for someone, whereas a list that
 * just stops looks full.
 */
function renderRoster(roster: readonly RosterEntry[], capacity: number): HTMLElement {
  const rows: HTMLElement[] = roster.map((entry) =>
    el('li', { className: entry.you ? 'seat seat--you' : 'seat' }, [
      el('span', { className: 'seat__num', text: String(entry.seat + 1) }),
      el('span', { className: 'seat__name', text: entry.you ? `${entry.name} (you)` : entry.name }),
      el('span', {
        className: entry.connected ? 'seat__state seat__state--on' : 'seat__state',
        text: entry.connected ? 'connected' : 'connecting…',
      }),
    ]),
  );

  for (let seat = roster.length; seat < capacity; seat += 1) {
    rows.push(
      el('li', { className: 'seat seat--empty' }, [
        el('span', { className: 'seat__num', text: String(seat + 1) }),
        el('span', { className: 'seat__name', text: 'Empty' }),
        el('span', { className: 'seat__state', text: 'open' }),
      ]),
    );
  }

  return el('ul', { className: 'seats', attrs: { 'aria-label': 'Players in this room' } }, rows);
}

/** Shown to a joining player before they have a seat to sit in. */
export function renderJoining(props: {
  code: string;
  message: string;
  failed: boolean;
  onBack: () => void;
}): HTMLElement {
  return el('section', { className: 'stack stack--centre' }, [
    el('p', { className: 'muted', text: 'Joining room' }),
    el('div', { className: 'code-display', text: props.code }),
    el('p', {
      className: props.failed ? 'notice notice--error' : 'lead',
      text: props.message,
      attrs: { role: 'status' },
    }),
    button({
      label: props.failed ? 'Back to the store' : 'Cancel',
      tone: 'ghost',
      onClick: props.onBack,
    }),
  ]);
}
