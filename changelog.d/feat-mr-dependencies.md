### Added

- Merge request dependencies (the REST `blocks` API). A blocking merge request is
  `{project_id, merge_request_iid}` (the server resolves its global id) or its global `id`.
  With `GITLAB_TOOLSETS` unset, the core tools take new params: `blocking_merge_requests`
  on `create_merge_request`, `add_blocking_merge_requests` and
  `remove_blocking_merge_requests` on `update_merge_request`, and `include_dependencies`
  on `get_merge_request` (adds `blocked_by` and `blocking`). Dependency changes run after
  the create or update and are not atomic; failures are returned in `dependency_errors`.
- With `GITLAB_TOOLSETS` set, the `merge_requests` toolset adds
  `list_merge_request_dependencies`, `create_merge_request_dependency`, and
  `delete_merge_request_dependency` instead, and the core tools keep their schemas.
  `discover_tools` does not add these tools while `GITLAB_TOOLSETS` is unset;
  `GITLAB_TOOLS` can still name one. `delete_merge_request_dependency` is destructive
  and blocked in `GITLAB_PERMISSION_MODE=modify`.
