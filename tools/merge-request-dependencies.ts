import { GITLAB_TOOLSETS_RAW } from "../config.js";

/**
 * Merge request dependencies (REST `blocks` API) come in one of two shapes:
 *
 * - `GITLAB_TOOLSETS` unset (the lean default): params on the core MR tools —
 *   `blocking_merge_requests` on create_merge_request, `add_blocking_merge_requests` /
 *   `remove_blocking_merge_requests` on update_merge_request, `include_dependencies` on
 *   get_merge_request. The dedicated tools are not listed, and `discover_tools` does not
 *   add them, because the params already cover them. `GITLAB_TOOLS` can still name one.
 * - `GITLAB_TOOLSETS` set: the dedicated tools below in the `merge_requests` toolset, and the
 *   core MR tools keep their schemas without the dependency params.
 */
export const MERGE_REQUEST_DEPENDENCY_TOOLS: ReadonlySet<string> = new Set([
  "list_merge_request_dependencies",
  "create_merge_request_dependency",
  "delete_merge_request_dependency",
]);

/** Same "unset" rule as the slim profile: missing or blank. */
export function usesMergeRequestDependencyParams(toolsetsRaw: string | undefined): boolean {
  return toolsetsRaw === undefined || toolsetsRaw.trim() === "";
}

export const MERGE_REQUEST_DEPENDENCY_PARAMS =
  usesMergeRequestDependencyParams(GITLAB_TOOLSETS_RAW);

/** In params mode the dedicated tools stay off unless `GITLAB_TOOLS` names them. */
export function isExcludedByDependencyParams(
  toolName: string,
  dependencyParams: boolean,
  explicitlyEnabledTools: ReadonlySet<string>
): boolean {
  return (
    dependencyParams &&
    MERGE_REQUEST_DEPENDENCY_TOOLS.has(toolName) &&
    !explicitlyEnabledTools.has(toolName)
  );
}
