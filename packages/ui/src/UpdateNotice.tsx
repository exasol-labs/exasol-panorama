/**
 * A new version is ready, said as quietly as that can be said.
 *
 * Panorama installs an update when the application closes and never while it is
 * open — see `plans/panorama-live-updates-plan.md`. That is the right policy and
 * it needs one line of interface, because an update nobody is told about is one
 * nobody gets: a window left open for a week runs last week's build.
 *
 * So this is a line of text, and it is deliberately nothing more. Not a dialog:
 * a dialog is an interruption, which is what the policy exists to avoid. Not a
 * toast: a message that removes itself is a message somebody who was reading a
 * query never saw. Not a button: there is nothing to press, because the update
 * applies itself the next time the application is closed, and offering to do it
 * now would put the interruption back.
 *
 * It says what will happen rather than asking for a decision, and it stays until
 * it stops being true — which for somebody who never quits is forever, and that
 * is correct, because for them it is true forever.
 */

/** How the new version gets used, which differs by what Panorama is running in. */
export type UpdateApplies =
  /** The desktop shell installs it while the window is closing. */
  | 'on-quit'
  /**
   * A browser install has a new service worker waiting behind this one; it takes
   * over once every window of the application has gone. Nothing can be installed
   * on the user's behalf, so the sentence asks rather than promises.
   */
  | 'on-reopen';

export interface UpdateNoticeProps {
  /**
   * What the waiting version calls itself, where that is known.
   *
   * `null` is not a failure worth hiding the notice over: "a new version" is less
   * useful than a number and much more useful than silence.
   */
  readonly version: string | null;
  readonly applies: UpdateApplies;
}

const subject = (version: string | null): string =>
  version === null ? 'A new version' : `Panorama ${version}`;

const outcome = (applies: UpdateApplies): string =>
  applies === 'on-quit'
    ? 'it will be installed when you quit.'
    : 'close and reopen Panorama to use it.';

export const UpdateNotice = ({ version, applies }: UpdateNoticeProps): React.JSX.Element => (
  /*
   * `status` rather than `alert`: an alert interrupts a screen reader mid-
   * sentence, which is exactly the rudeness this notice is designed around.
   * `polite` is what "we will mention it when you are between things" means.
   */
  <p className="pn-update" role="status">
    <span className="pn-update__dot" aria-hidden="true" />
    {`${subject(version)} is ready — ${outcome(applies)}`}
  </p>
);
