import type { ResolvedExecutionEnvironment } from "../../core/domain/execution.js";
import { ResolvedSecrets } from "../../core/domain/secret-values.js";
import { InvalidArgumentError, ErrorCode } from "../../core/errors/index.js";
import { environmentName, profileBaseUrl } from "../schema/constraints.js";
import type { EnvironmentProfiles } from "../schema/index.js";

import type {
  EnvironmentIssue,
  EnvironmentResolution,
  ResolveEnvironmentInput,
} from "./contracts.js";

/**
 * The one environment variable an approved override may come from.
 *
 * One name, spelled once. A naming scheme per property — `QAT_<PROPERTY>` — reads well until the third property, at
 * which point the override surface has quietly become "everything, if you guess the name".
 */
export const BASE_URL_ENVIRONMENT_VARIABLE = "QAT_BASE_URL";

/**
 * Resolve the environment a run targets.
 *
 * Pure apart from the two injected readers. Deterministic: the same document, request and ambient values produce the
 * same object, and the object is frozen.
 *
 * The input type lives in `contracts.ts` rather than here, because a caller annotating a variable with the published
 * type must be annotating the same type this function accepts — two structurally identical interfaces are two things
 * that can drift, and the drift would surface as an unfixable-looking error at a call site.
 */
export function resolveEnvironment(
  input: ResolveEnvironmentInput,
): EnvironmentResolution {
  const issues: EnvironmentIssue[] = [];

  // 1. Which name? An explicit request wins; otherwise the default the configuration stage already derived.
  const requested = input.requested;

  if (requested !== undefined) {
    // Validated before lookup, so a typo is reported as a malformed name rather than as an unknown environment — two
    // different mistakes with two different fixes.
    const valid = environmentName.safeParse(requested);
    if (!valid.success) {
      return {
        ok: false,
        issues: [
          {
            code: "ENVIRONMENT_NAME_INVALID",
            severity: "error",
            message: `"${requested}" is not a valid environment name.`,
            remediation:
              "Use lower-case letters, digits and hyphens, starting with a letter, at most 32 characters.",
          },
        ],
      };
    }
  }

  const available = input.profiles ?? {};
  const chosen = requested ?? input.defaultEnvironment.name;

  if (chosen === undefined) {
    if (input.requireEnvironment === false) {
      return {
        ok: true,
        name: undefined,
        origin: "none",
        environment: Object.freeze({
          ...noTarget(),
          variables: Object.freeze({}),
          secrets: ResolvedSecrets.empty(),
        }),
      };
    }

    return {
      ok: false,
      issues: [
        {
          code: "ENVIRONMENT_NONE_SELECTED",
          severity: "error",
          message:
            declaredNames(available).length === 0
              ? "This project declares no environments, and no environment was requested."
              : "This project declares several environments and no default, and none was requested.",
          remediation:
            declaredNames(available).length === 0
              ? "Declare an environment in qat.config.json, or pass --environment once one exists."
              : `Pass --environment with one of: ${declaredNames(available).join(", ")}.`,
        },
      ],
    };
  }

  const profile = available[chosen];

  if (profile === undefined) {
    // The name is well formed and the project does not have it. There is nothing else to say, so say which ones exist.
    return {
      ok: false,
      issues: [
        {
          code: "ENVIRONMENT_UNKNOWN",
          severity: "error",
          message: `"${chosen}" is not an environment this project declares.`,
          remediation:
            declaredNames(available).length === 0
              ? "This project declares no environments. Add one to qat.config.json."
              : `Use one of: ${declaredNames(available).join(", ")}.`,
        },
      ],
    };
  }

  // 2. The target: flag, then variable, then profile. Both overrides are checked with the file's own constraint before
  // anything selects between them — see `requireUsableOverride` for why the refusal cannot be left to a parser, and
  // `selectTarget` for why the order is written here rather than delegated.
  //
  // The flag is checked first because it outranks the variable: when both are wrong, the value typed for this invocation
  // is the one worth reporting.
  const baseUrl = selectTarget({
    flag: requireUsableOverride(input.fromFlag?.baseUrl, "--base-url"),
    fromEnvironment: requireUsableOverride(
      input.environment[BASE_URL_ENVIRONMENT_VARIABLE],
      BASE_URL_ENVIRONMENT_VARIABLE,
    ),
    profile: profile.baseUrl,
  });

  // 3. Secrets. Every missing one is reported, not just the first: a reader fixes them in one pass.
  const resolvedSecrets: (readonly [string, string])[] = [];

  for (const secretName of Object.keys(profile.secrets ?? {})) {
    const reference = profile.secrets?.[secretName];
    if (reference === undefined) continue;

    const value = input.readSecret(reference.name);

    if (value === undefined) {
      issues.push({
        code: "SECRET_UNRESOLVED",
        severity: "error",
        // The reference's variable name is configuration and may be printed; the value cannot be, because there is none.
        message: `The secret "${secretName}" reads from ${reference.name}, which is not set.`,
        remediation: `Set ${reference.name} in the environment that runs the command. QAT does not store secret values.`,
      });
      continue;
    }

    resolvedSecrets.push([secretName, value] as const);
  }

  if (issues.length > 0) return { ok: false, issues };

  // 4. Freeze. A caller that mutated this would change what a later consumer reads, and nothing would say so.
  //
  // The name and the origin sit on the *result*, not inside the value: the request already carries the environment's
  // identifier, and a second field holding the same string is how a run recorded under one name ends up targeting
  // another. The value answers "what does this environment provide"; the result answers "which one, and why that one".
  const environment: ResolvedExecutionEnvironment = Object.freeze({
    ...baseUrl,
    // Variables are handed over exactly as the profile wrote them. Nothing here guesses that a value "looks like a path"
    // and rewrites it: a variable is opaque text, and a rewrites-everything merge is how a URL ends up as a filesystem
    // path. Path anchoring happened once, in the stage that owns it.
    variables: Object.freeze({ ...(profile.variables ?? {}) }),
    secrets: ResolvedSecrets.from(resolvedSecrets),
  });

  return {
    ok: true,
    name: chosen,
    origin: requested === undefined ? "default" : "requested",
    environment,
  };
}

/**
 * The target, from the three levels that may supply one.
 *
 * ## Why the order is written out rather than delegated
 *
 * The shared precedence helper resolves a setting by *looking it up in the ambient environment itself*. This stage is
 * handed an ambient map by its caller — that is the only reason it can be tested without mutating the process — and a
 * helper that consults `process.env` would silently ignore it. So the three levels are stated here, in the order they
 * read, over values that are already in hand and already validated.
 *
 * That is a deliberate reversal of a "call the resolver, do not become one" rule, and the rule still holds for settings
 * with a parser policy and no injected source: the log level goes through `resolveLogLevel` because its caller passes the
 * value it already looked up. What does not hold is delegating to something that reads state the caller was promised
 * control of. If the helper ever accepts an injected map, this function is the thing to delete.
 *
 * A straight-line selection is not a merge: three checks in a fixed order, no iteration, no key that can be added at a
 * call site.
 */
function selectTarget(levels: {
  readonly flag: string | undefined;
  readonly fromEnvironment: string | undefined;
  readonly profile: string | undefined;
}): Pick<ResolvedExecutionEnvironment, "baseUrl" | "baseUrlSource"> {
  if (levels.flag !== undefined) {
    return { baseUrl: levels.flag, baseUrlSource: "flag" };
  }

  if (levels.fromEnvironment !== undefined) {
    return { baseUrl: levels.fromEnvironment, baseUrlSource: "environment" };
  }

  if (levels.profile !== undefined) {
    return { baseUrl: levels.profile, baseUrlSource: "configuration" };
  }

  return noTarget();
}

/** A target nobody supplied. `none` is the source, and the address is absent rather than empty. */
function noTarget(): Pick<
  ResolvedExecutionEnvironment,
  "baseUrl" | "baseUrlSource"
> {
  return { baseUrlSource: "none" };
}

/**
 * Refuse an override the file's rule would refuse, and otherwise hand it back.
 *
 * ## Why the refusal happens here rather than in a parser
 *
 * A precedence resolver typically treats a value it cannot parse as absent and moves to the next level. That is right
 * for a quiet setting such as a log level — an environment variable may belong to a container image nobody running the
 * command can edit — and wrong for a target. An operator who exported `QAT_BASE_URL` believes the run is pointed
 * somewhere; a run that quietly used the profile's address instead produces a result nobody can explain, and *it looks
 * entirely ordinary*.
 *
 * So both approved overrides are checked here, once, with the same constraint the profile's own field uses. The rule
 * that keeps that honest is that it is the same function: an override validated with an equivalent constraint would be a
 * way around the file's security rule, and no test of the file would notice.
 *
 * An empty value is absent rather than unusable — the same reading the variable utilities take — because a shell passing
 * on an inherited blank is not an instruction to point the run at nothing.
 */
function requireUsableOverride(
  value: string | undefined,
  source: string,
): string | undefined {
  if (value === undefined || value === "") return undefined;

  const result = profileBaseUrl.safeParse(value);

  if (result.success) return result.data;

  throw new InvalidArgumentError(
    ErrorCode.invalidArgument,
    `The value supplied for ${source} is not a usable base URL.`,
    {
      // The source, never the value: what was supplied could contain a credential, and this message is composed in the
      // one place that knows it does not have to repeat it.
      context: { source },
      remediation:
        "Supply an absolute http or https URL without a username or password, or remove the override to use the profile's value.",
    },
  );
}

function declaredNames(profiles: EnvironmentProfiles): readonly string[] {
  return Object.keys(profiles).sort();
}
