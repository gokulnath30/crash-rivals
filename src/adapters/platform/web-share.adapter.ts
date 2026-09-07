import type { SharePort, ShareOutcome } from '@app/ports/share.port.ts';

/**
 * Hands an invite to the platform share sheet, falling back to the clipboard.
 *
 * Cancelling a share is a normal thing to do, not an error, so an `AbortError`
 * is reported as `unavailable` rather than thrown — the lobby then shows the
 * link for the player to copy by hand.
 */
export class WebShareAdapter implements SharePort {
  async share(invite: { title: string; text: string; url: string }): Promise<ShareOutcome> {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(invite);
        return 'shared';
      } catch {
        // Fall through to the clipboard; a cancelled sheet is not a failure.
      }
    }

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(invite.url);
        return 'copied';
      } catch {
        return 'unavailable';
      }
    }

    return 'unavailable';
  }

  async copy(text: string): Promise<boolean> {
    if (!navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied permission, or a non-secure origin. The UI shows the link
      // instead so it can still be copied by hand.
      return false;
    }
  }
}
