// @ts-check
/**
 * Prettier configuration for QAT.
 *
 * Every setting here is a decision, and every decision is documented. Formatting
 * debates are only settled by a configuration nobody has to argue about again.
 */

/** @type {import('prettier').Config} */
export default {
  // 100 rather than the default 80. TypeScript's generics and option objects
  // routinely exceed 80 columns, and wrapping them makes config interfaces
  // considerably harder to read.
  printWidth: 100,

  // Two spaces. Not negotiable, and consistent with the JSON and YAML files
  // Prettier formats alongside the source.
  tabWidth: 2,
  useTabs: false,

  // Semicolons retained. Automatic semicolon insertion has well-known failure
  // modes with leading-paren and leading-bracket expressions, and this codebase
  // does not need to re-litigate them.
  semi: true,

  // Single quotes for strings. Double quotes remain where required: JSX (not
  // used here) and strings containing an apostrophe.
  singleQuote: true,

  // Only quote object properties when required for validity.
  quoteProps: "as-needed",

  // Trailing commas everywhere, including function parameters. This makes
  // multi-line additions produce one-line diffs instead of two.
  trailingComma: "all",

  bracketSpacing: true,
  bracketSameLine: false,

  // Always parenthesise a single arrow parameter. Removes a whole class of
  // trivial diff churn when a parameter is added.
  arrowParens: "always",

  // LF. Mandatory: the repository is developed on Windows and Linux, and
  // mixed endings make every diff unreadable. Enforced independently by
  // .gitattributes.
  endOfLine: "lf",

  overrides: [
    {
      // Do not reflow prose. Markdown line breaks are not semantic and reflowing
      // them rewrites entire documents on a one-sentence edit.
      files: ["*.md"],
      options: { proseWrap: "preserve" },
    },
    {
      // YAML convention prefers unquoted scalars where valid.
      files: ["*.yml", "*.yaml"],
      options: { singleQuote: false },
    },
    {
      // JSON does not permit trailing commas.
      files: ["*.json"],
      options: { trailingComma: "none" },
    },
  ],
};
