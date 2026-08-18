/**
 * What "set up this machine" says, and when it says it (DESIGN.md §6.4).
 *
 * Two pure functions, split out of `SetUpMachine.tsx` for a reason that is not
 * tidiness: whether the panel opens by itself depends on what the machine
 * running the tests happens to have installed, so an end-to-end assertion would
 * hold on some laptops and silently stop holding on others. A criterion that
 * quietly stops being checked is worse than one that was never claimed. Here it
 * is a function of two booleans and is checked everywhere.
 *
 * The sentence lives here for the same reason. It is the only place in the app
 * that *summarises* a host's problems in its own words rather than repeating the
 * host's, so getting it wrong means telling somebody their machine is fine when
 * it is not — which is the failure this whole feature exists to remove, with the
 * sign flipped.
 */

/**
 * Whether the panel opens without being asked.
 *
 * The situation triggers it, not a click — the same rule the attach panel's
 * search follows. Only the dead end opens it: no installed CLI *and* no model,
 * which is exactly what a fresh ssh host reports. Either one alone is something
 * that runs, and somebody who has one wants a picker rather than a setup form.
 * It fails cheaply if it is wrong: one extra folded row.
 */
export function opensOnItsOwn(anyCli: boolean, anyModels: boolean): boolean {
  return !anyCli && !anyModels;
}

/**
 * One line saying what is missing, addressed to a person.
 *
 * A CLI brings its own model, so it is sufficient on its own; the harness needs
 * a model, so a model is sufficient on its own. The middle case is worth its own
 * sentence rather than being folded into "ready": a machine with Claude Code and
 * no model server is genuinely usable and genuinely limited, and saying only the
 * first half is how somebody ends up choosing the harness and finding it cannot
 * run.
 */
export function setupSummary(where: string, anyCli: boolean, anyModels: boolean): string {
  if (opensOnItsOwn(anyCli, anyModels)) {
    return `Nothing on ${where} can run an agent yet: no agent CLI is installed and no model server answered.`;
  }
  if (anyCli && !anyModels) {
    return `${where} has an agent CLI but no model server, so the harness cannot run here.`;
  }
  return `${where} is ready. You can still add another CLI, a model server, or an API endpoint.`;
}
