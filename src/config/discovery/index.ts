/**
 * Public surface of configuration discovery.
 *
 * One function and one result type. The inspection helpers are not exported: they answer a question about a single path,
 * and a caller reaching for one wants a different question answered than this module answers.
 */
export {
  ConfigurationLocation,
  type AbsentConfiguration,
  type ConfigurationDiscovery,
  type FoundConfiguration,
  type OccupiedConfiguration,
} from "./contracts.js";
export { locateConfiguration } from "./locate.js";
