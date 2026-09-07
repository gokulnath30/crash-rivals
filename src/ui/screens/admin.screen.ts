import type { AccessGrant, Role } from '@domain/identity/player.ts';
import { button, el } from '../dom.ts';

/**
 * Who runs the arcade.
 *
 * This was the guest list, and it decided who could play. It no longer does:
 * anyone signed in with Google may play, so what is left here is the admin
 * list — who may open this screen and change it. The same rule is enforced
 * again in `firebase/firestore.rules`, because a screen that hides a button is
 * not a permission system.
 *
 * A `player` row is now a no-op as far as playing goes. It is still allowed,
 * because removing the role would mean rewriting every existing row, and a
 * note against a name is useful for remembering who someone is.
 */
export function renderAdmin(props: {
  grants: readonly AccessGrant[];
  loading: boolean;
  error: string | null;
  note: string | null;
  ownEmail: string | null;
  onInvite: (input: { email: string; role: Role; note: string | null }) => void;
  onRevoke: (email: string) => void;
  onRefresh: () => void;
  onBack: () => void;
}): HTMLElement {
  const email = el('input', {
    className: 'text-input',
    attrs: {
      type: 'email',
      placeholder: 'friend@example.com',
      autocomplete: 'off',
      'aria-label': 'Email address to add',
    },
  });
  const label = el('input', {
    className: 'text-input',
    attrs: { type: 'text', placeholder: 'who they are (optional)', 'aria-label': 'Note' },
  });
  const role = el('select', { className: 'text-input', attrs: { 'aria-label': 'Role' } }, [
    el('option', { text: 'Player', attrs: { value: 'player' } }),
    el('option', { text: 'Admin', attrs: { value: 'admin' } }),
  ]);

  const invite = (): void => {
    const address = email.value.trim();
    if (!address) return;
    props.onInvite({
      email: address,
      role: role.value === 'admin' ? 'admin' : 'player',
      note: label.value.trim() || null,
    });
    email.value = '';
    label.value = '';
  };

  email.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') invite();
  });

  const children: HTMLElement[] = [
    el('div', { className: 'row row--between' }, [
      button({ label: '← Back', tone: 'ghost', onClick: props.onBack }),
      button({ label: 'Refresh', tone: 'ghost', onClick: props.onRefresh }),
    ]),
    el('h2', { className: 'section-title section-title--big', text: 'Admins' }),
    el('p', {
      className: 'lead',
      text:
        'Anyone with a Google account can play — there is no list to be added to. ' +
        'This list is who may open this screen: give someone the Admin role and ' +
        'they can add and remove admins too.',
    }),
    el('div', { className: 'panel' }, [
      el('h3', { className: 'panel__title', text: 'Add someone' }),
      el('div', { className: 'row row--wrap' }, [email, label, role, button({ label: 'Add', onClick: invite })]),
    ]),
  ];

  if (props.note) children.push(el('p', { className: 'notice', text: props.note, attrs: { role: 'status' } }));
  if (props.error) children.push(el('p', { className: 'notice notice--error', text: props.error }));

  if (props.loading) {
    children.push(el('p', { className: 'muted', text: 'Reading the list…' }));
  } else if (props.grants.length === 0) {
    children.push(el('p', { className: 'muted', text: 'No admins recorded yet.' }));
  } else {
    children.push(
      el(
        'ul',
        { className: 'grants' },
        props.grants.map((grant) => renderGrant(grant, props.ownEmail, props.onRevoke)),
      ),
    );
  }

  return el('section', { className: 'stack' }, children);
}

function renderGrant(
  grant: AccessGrant,
  ownEmail: string | null,
  onRevoke: (email: string) => void,
): HTMLElement {
  const isSelf = ownEmail !== null && ownEmail === grant.email;

  const meta: HTMLElement[] = [el('span', { className: 'pill', text: grant.role })];
  if (grant.note) meta.push(el('span', { className: 'muted', text: grant.note }));
  if (grant.grantedAt > 0) {
    meta.push(
      el('span', {
        className: 'muted',
        text: new Date(grant.grantedAt).toLocaleDateString(),
      }),
    );
  }

  return el('li', { className: 'grant' }, [
    el('div', {}, [el('strong', { text: grant.email }), el('div', { className: 'row row--tight' }, meta)]),
    // The owner's own row has no remove button — locking yourself out of your
    // own arcade should not be one careless tap away.
    isSelf
      ? el('span', { className: 'muted', text: 'you' })
      : button({
          label: 'Remove',
          tone: 'danger',
          onClick: () => {
            onRevoke(grant.email);
          },
        }),
  ]);
}
