/**
 * Selects one condition result from a Cypress health assessment.
 *
 * Assessment always returns one result per check, so a missing entry means the
 * vocabulary and the assessor have drifted apart — a programming error. Throwing is
 * correct: the check engine isolates a throwing check and reports it as failed, whereas
 * inventing a pass would be the one outcome worse than crashing.
 */
import type { CypressConditionResult } from "../../../project/cypress-health/index.js";

export function pickConditionResult(
  results: readonly CypressConditionResult[],
  checkId: CypressConditionResult["checkId"],
): CypressConditionResult {
  const own = results.find((candidate) => candidate.checkId === checkId);

  if (own === undefined) {
    throw new Error(
      `Cypress health assessment did not return a ${checkId} result`,
    );
  }

  return own;
}
