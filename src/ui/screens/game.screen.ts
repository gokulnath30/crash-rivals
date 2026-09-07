import {
  modeLabel,
  type GameDefinition,
  type GameMode,
} from '@domain/catalog/game-definition.ts';
import { CODE_LENGTH, normaliseInviteCode } from '@domain/lobby/invite-code.ts';
import { button, el } from '../dom.ts';

const REQUIREMENT_NOTES: Readonly<Record<string, string>> = {
  camera: 'Needs a webcam',
  keyboard: 'Needs a keyboard',
  webgl: 'Needs 3D graphics',
  network: 'Needs a connection',
};

/**
 * A game's own page: what it is, how to play it, and the three ways in.
 *
 * Online play is offered but disabled when there is no project behind it,
 * with the reason on the button rather than hidden in a console message.
 */
export function renderGame(props: {
  game: GameDefinition;
  onPlay: (mode: GameMode) => void;
  onJoin: (code: string) => void;
  onBack: () => void;
  onlineAvailable: boolean;
  onlineReason: string | null;
  busy: GameMode | null;
  error: string | null;
  /** Pre-filled from an invite link, if the player arrived on one. */
  initialCode: string;
}): HTMLElement {
  const modeButtons = props.game.modes.map((mode) => {
    const online = mode === 'online-versus';
    const blocked = online && !props.onlineAvailable;
    return button({
      label: props.busy === mode ? 'Setting up…' : modeLabel(props.game, mode),
      tone: mode === 'online-versus' ? 'primary' : 'ghost',
      disabled: blocked || props.busy !== null,
      onClick: () => {
        props.onPlay(mode);
      },
      ...(blocked && props.onlineReason ? { describedBy: 'online-reason' } : {}),
    });
  });

  const children: HTMLElement[] = [
    el('div', { className: 'row row--between' }, [
      button({ label: '← All games', tone: 'ghost', onClick: props.onBack }),
      el(
        'div',
        { className: 'row row--tight' },
        props.game.requirements.map((requirement) =>
          el('span', { className: 'pill', text: REQUIREMENT_NOTES[requirement] ?? requirement }),
        ),
      ),
    ]),
    el('h2', { className: 'section-title section-title--big', text: props.game.title }),
    el('p', { className: 'lead', text: props.game.blurb }),
    el('div', { className: 'row row--wrap' }, modeButtons),
  ];

  if (!props.onlineAvailable && props.onlineReason) {
    children.push(
      el('p', {
        className: 'muted',
        text: props.onlineReason,
        attrs: { id: 'online-reason' },
      }),
    );
  }

  if (props.game.modes.includes('online-versus')) {
    children.push(renderJoinBox(props));
  }

  children.push(
    el('div', { className: 'panel' }, [
      el('h3', { className: 'panel__title', text: 'How to play' }),
      el(
        'ol',
        { className: 'steps' },
        props.game.howToPlay.map((step) => el('li', { text: step })),
      ),
    ]),
  );

  if (props.error) {
    children.push(el('p', { className: 'notice notice--error', text: props.error }));
  }

  return el('section', { className: 'stack' }, children);
}

/** The "my friend sent me a code" path. */
function renderJoinBox(props: {
  onJoin: (code: string) => void;
  onlineAvailable: boolean;
  initialCode: string;
}): HTMLElement {
  const input = el('input', {
    className: 'code-input',
    attrs: {
      id: 'join-code',
      maxlength: String(CODE_LENGTH),
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      inputmode: 'text',
      placeholder: '····',
      'aria-label': 'Room code',
    },
  });
  input.value = props.initialCode;
  if (!props.onlineAvailable) input.disabled = true;

  const submit = (): void => {
    if (input.value.length > 0) props.onJoin(input.value);
  };

  // Normalise as they type, so a pasted "room-a1b2" becomes a code and a
  // typed lower-case "o" becomes the zero it was meant to be.
  input.addEventListener('input', () => {
    input.value = normaliseInviteCode(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });

  return el('div', { className: 'panel' }, [
    el('h3', { className: 'panel__title', text: 'Got a code?' }),
    el('div', { className: 'row' }, [
      input,
      button({ label: 'Join', onClick: submit, disabled: !props.onlineAvailable }),
    ]),
  ]);
}
