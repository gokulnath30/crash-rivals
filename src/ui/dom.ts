/**
 * A few DOM helpers, in place of a framework.
 *
 * This app has five screens and no shared mutable view state worth
 * reconciling, so a virtual DOM would be a dependency, a build step and a
 * mental model bought for nothing. What it does need is to never build markup
 * by concatenating strings — `el` sets text through `textContent`, so a player
 * called `<script>` is a player called `<script>` and not a security incident.
 */

interface ElementOptions {
  readonly className?: string;
  /** Set as text, never as HTML. */
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly dataset?: Readonly<Record<string, string>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  for (const [name, value] of Object.entries(options.dataset ?? {})) {
    node.dataset[name] = value;
  }
  if (children.length > 0) node.append(...children);
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export interface ButtonOptions {
  readonly label: string;
  readonly onClick: () => void;
  /** 'primary' | 'ghost' | 'danger' — maps to a CSS modifier. */
  readonly tone?: 'primary' | 'ghost' | 'danger';
  readonly disabled?: boolean;
  /** Read out by assistive tech when the label alone is not enough. */
  readonly describedBy?: string;
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const node = el('button', {
    className: `btn btn--${options.tone ?? 'primary'}`,
    text: options.label,
    attrs: { type: 'button' },
  });
  if (options.disabled) node.disabled = true;
  if (options.describedBy) node.setAttribute('aria-describedby', options.describedBy);
  node.addEventListener('click', options.onClick);
  return node;
}

/** `addEventListener` that hands back its own removal, for symmetric teardown. */
export function on<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void;
export function on<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  listener: (event: DocumentEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void;
export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  listener: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void;
export function on(
  target: EventTarget,
  type: string,
  listener: (event: Event) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, listener, options);
  return () => {
    target.removeEventListener(type, listener, options);
  };
}

/** An avatar, falling back to initials when there is no picture to show. */
export function avatar(input: { url: string | null; initials: string; label: string }): HTMLElement {
  if (input.url) {
    const image = el('img', {
      className: 'avatar',
      attrs: {
        src: input.url,
        alt: input.label,
        width: '32',
        height: '32',
        referrerpolicy: 'no-referrer',
        loading: 'lazy',
      },
    });
    return image;
  }
  return el('span', {
    className: 'avatar avatar--initials',
    text: input.initials,
    attrs: { 'aria-label': input.label, role: 'img' },
  });
}
