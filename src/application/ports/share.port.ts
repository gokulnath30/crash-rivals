/** How an invite gets out of the browser and to a friend. */
export type ShareOutcome = 'shared' | 'copied' | 'unavailable';

export interface SharePort {
  /**
   * Offers the invite through the platform share sheet, falling back to the
   * clipboard. Never throws: a share the player cancelled is not an error.
   */
  share(invite: { title: string; text: string; url: string }): Promise<ShareOutcome>;

  /**
   * Puts text on the clipboard and nothing else.
   *
   * Separate from `share` because a button labelled "Copy the link" that opens
   * a share sheet is a button that lied. Reports whether it worked.
   */
  copy(text: string): Promise<boolean>;
}
