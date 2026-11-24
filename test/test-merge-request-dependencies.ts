/**
 * Merge request dependencies (REST `blocks` API) in both tool shapes:
 * - GITLAB_TOOLSETS unset: params on create/update/get_merge_request, no dedicated tools.
 * - GITLAB_TOOLSETS set: list/create/delete_merge_request_dependency in merge_requests.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert";
import { spawn } from "child_process";
import { MockGitLabServer, findMockServerPort } from "./utils/mock-gitlab-server.js";
import { expectToolError } from "./utils/tool-error.js";

const MOCK_TOKEN = "glpat-mock-token-mr-dependencies";
const TEST_PROJECT_ID = "456";
const OTHER_PROJECT_ID = "789";
const TEST_MR_IID = "42";
const BLOCK_ID = "31";
const FAILING_BLOCKING_ID = 9999;
const DEDICATED_TOOLS = [
  "list_merge_request_dependencies",
  "create_merge_request_dependency",
  "delete_merge_request_dependency",
];

const BLOCK = {
  id: Number(BLOCK_ID),
  blocking_merge_request: { id: 9007, iid: 7, project_id: Number(OTHER_PROJECT_ID) },
  blocked_merge_request: { id: 9042, iid: 42, project_id: Number(TEST_PROJECT_ID) },
  project_id: Number(TEST_PROJECT_ID),
};

const MERGE_REQUEST = {
  id: 9042,
  iid: 42,
  project_id: Number(TEST_PROJECT_ID),
  title: "Feature",
  description: null,
  state: "opened",
  author: { id: 1, username: "dev" },
  source_branch: "feature",
  target_branch: "main",
  web_url: "https://gitlab.example.com/g/p/-/merge_requests/42",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  merged_at: null,
  closed_at: null,
  merge_commit_sha: null,
};

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface RpcRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface RpcResponse {
  readonly id: number;
  readonly result?: {
    readonly isError?: boolean;
    readonly content?: Array<{ readonly text?: string }>;
    readonly tools?: Array<{
      readonly name: string;
      readonly inputSchema: { properties?: object };
    }>;
  };
  readonly error?: { readonly message?: string };
}

/** Send several JSON-RPC requests to one server process; responses come back in request order. */
async function rpc(
  requests: readonly RpcRequest[],
  env: NodeJS.ProcessEnv
): Promise<RpcResponse[]> {
  return new Promise<RpcResponse[]>((resolve, reject) => {
    const proc = spawn("node", ["build/index.js"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    let output = "";
    let errorOutput = "";
    proc.stdout?.on("data", (d: Buffer) => (output += d));
    proc.stderr?.on("data", (d: Buffer) => (errorOutput += d));

    const pending = new Set(requests.map((_, index) => index + 1));
    proc.stdout?.on("data", () => {
      // Only complete lines: a large tools/list reply arrives in several chunks.
      for (const line of output.split("\n").slice(0, -1)) {
        if (line.startsWith("{")) {
          const id = (JSON.parse(line) as { id?: number }).id;
          if (id !== undefined) pending.delete(id);
        }
      }
      if (pending.size === 0) proc.stdin?.end();
    });

    proc.on("close", code => {
      if (code !== 0) {
        return reject(new Error(`Process exited with code ${code}: ${errorOutput}`));
      }

      const responses = output
        .split("\n")
        .filter(line => line.startsWith("{"))
        .map(line => JSON.parse(line) as RpcResponse)
        .filter(response => typeof response.id === "number")
        .sort((a, b) => a.id - b.id);
      resolve(responses);
    });

    // Write one at a time in order; the server answers each before stdin closes.
    requests.forEach((request, index) => {
      proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request }) + "\n");
    });
  });
}

/** One tools/call: the parsed JSON text, or the isError result as is. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): Promise<any> {
  const [response] = await rpc([{ method: "tools/call", params: { name, arguments: args } }], env);
  if (response.error) {
    throw new Error(response.error.message ?? "JSON-RPC error");
  }
  if (response.result?.isError === true) {
    return response.result;
  }
  const text = response.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : response.result;
}

function toolProperties(response: RpcResponse, toolName: string): string[] | undefined {
  const tool = response.result?.tools?.find(t => t.name === toolName);
  return tool ? Object.keys(tool.inputSchema.properties ?? {}) : undefined;
}

describe("merge request dependencies", () => {
  let mockGitLab: MockGitLabServer;
  let mockGitLabUrl: string;
  let requests: RecordedRequest[] = [];

  const env = (toolsets: string) => ({
    GITLAB_API_URL: `${mockGitLabUrl}/api/v4`,
    GITLAB_PERSONAL_ACCESS_TOKEN: MOCK_TOKEN,
    GITLAB_TOOLSETS: toolsets,
    GITLAB_TOOLS: "",
  });
  const paramsEnv = () => env("");
  const toolsEnv = () => env("merge_requests");
  const calls = () => requests.map(r => `${r.method} ${r.path}`);

  const mrPath = `/projects/${TEST_PROJECT_ID}/merge_requests/${TEST_MR_IID}`;

  before(async () => {
    const mockPort = await findMockServerPort();
    mockGitLab = new MockGitLabServer({
      port: mockPort,
      validTokens: [MOCK_TOKEN],
    });

    const record = (method: string, path: string, body: unknown) =>
      requests.push({ method, path, body });

    mockGitLab.addMockHandler("post", `/projects/${TEST_PROJECT_ID}/merge_requests`, (req, res) => {
      record("POST", req.path, req.body);
      res.status(201).json(MERGE_REQUEST);
    });
    mockGitLab.addMockHandler("get", mrPath, (req, res) => {
      record("GET", req.path, undefined);
      res.json(MERGE_REQUEST);
    });
    mockGitLab.addMockHandler("put", mrPath, (req, res) => {
      record("PUT", req.path, req.body);
      res.json(MERGE_REQUEST);
    });
    mockGitLab.addMockHandler("get", `${mrPath}/blocks`, (req, res) => {
      record("GET", req.path, undefined);
      res.json([BLOCK]);
    });
    mockGitLab.addMockHandler("get", `${mrPath}/blockees`, (req, res) => {
      record("GET", req.path, undefined);
      res.json([]);
    });
    mockGitLab.addMockHandler("post", `${mrPath}/blocks`, (req, res) => {
      record("POST", req.path, req.body);
      if (req.body?.blocking_merge_request_id === FAILING_BLOCKING_ID) {
        res.status(409).json({ message: "Block already exists" });
        return;
      }
      res.status(201).json(BLOCK);
    });
    mockGitLab.addMockHandler("delete", `${mrPath}/blocks/${BLOCK_ID}`, (req, res) => {
      record("DELETE", req.path, undefined);
      res.status(204).end();
    });
    mockGitLab.addMockHandler(
      "get",
      `/projects/${OTHER_PROJECT_ID}/merge_requests/7`,
      (req, res) => {
        record("GET", req.path, undefined);
        res.json({ id: 9007, iid: 7, project_id: Number(OTHER_PROJECT_ID) });
      }
    );

    await mockGitLab.start();
    mockGitLabUrl = mockGitLab.getUrl();
  });

  after(async () => {
    await mockGitLab.stop();
  });

  beforeEach(() => {
    requests = [];
  });

  describe("with GITLAB_TOOLSETS unset", () => {
    test("lists the dependency params on the core MR tools and no dedicated tools", async () => {
      const [list] = await rpc([{ method: "tools/list", params: {} }], paramsEnv());

      assert.ok(toolProperties(list, "create_merge_request")?.includes("blocking_merge_requests"));
      const updateProperties = toolProperties(list, "update_merge_request") ?? [];
      assert.ok(updateProperties.includes("add_blocking_merge_requests"));
      assert.ok(updateProperties.includes("remove_blocking_merge_requests"));
      assert.ok(toolProperties(list, "get_merge_request")?.includes("include_dependencies"));
      for (const name of DEDICATED_TOOLS) {
        assert.strictEqual(toolProperties(list, name), undefined, `${name} should not be listed`);
      }
    });

    test("discover_tools merge_requests does not add the dedicated tools", async () => {
      const [, list] = await rpc(
        [
          {
            method: "tools/call",
            params: { name: "discover_tools", arguments: { category: "merge_requests" } },
          },
          { method: "tools/list", params: {} },
        ],
        paramsEnv()
      );

      assert.ok(toolProperties(list, "merge_merge_request"), "merge_requests should be active");
      for (const name of DEDICATED_TOOLS) {
        assert.strictEqual(toolProperties(list, name), undefined, `${name} should not be added`);
      }
    });

    test("a dedicated tool call points at the params", async () => {
      const [response] = await rpc(
        [
          {
            method: "tools/call",
            params: {
              name: "list_merge_request_dependencies",
              arguments: { project_id: TEST_PROJECT_ID, merge_request_iid: TEST_MR_IID },
            },
          },
        ],
        paramsEnv()
      );

      const text = response.error?.message ?? response.result?.content?.[0]?.text ?? "";
      assert.match(text, /While GITLAB_TOOLSETS is unset, use blocking_merge_requests/);
      assert.doesNotMatch(text, /call discover_tools/);
      assert.strictEqual(requests.length, 0);
    });

    test("create_merge_request adds each blocking MR after creating it", async () => {
      const result = await callTool(
        "create_merge_request",
        {
          project_id: TEST_PROJECT_ID,
          title: "Feature",
          source_branch: "feature",
          target_branch: "main",
          blocking_merge_requests: [{ project_id: OTHER_PROJECT_ID, merge_request_iid: 7 }, "9008"],
        },
        paramsEnv()
      );

      assert.strictEqual(result.iid, "42");
      assert.strictEqual(result.dependency_errors, undefined);
      assert.deepStrictEqual(calls(), [
        `POST /projects/${TEST_PROJECT_ID}/merge_requests`,
        `GET /projects/${OTHER_PROJECT_ID}/merge_requests/7`,
        `POST ${mrPath}/blocks`,
        `POST ${mrPath}/blocks`,
      ]);
      assert.strictEqual("blocking_merge_requests" in (requests[0].body as object), false);
      assert.deepStrictEqual(requests[2].body, { blocking_merge_request_id: 9007 });
      assert.deepStrictEqual(requests[3].body, { blocking_merge_request_id: 9008 });
    });

    test("create_merge_request returns the MR and the failed blocks", async () => {
      const result = await callTool(
        "create_merge_request",
        {
          project_id: TEST_PROJECT_ID,
          title: "Feature",
          source_branch: "feature",
          target_branch: "main",
          blocking_merge_requests: [FAILING_BLOCKING_ID, 9007],
        },
        paramsEnv()
      );

      assert.strictEqual(result.iid, "42");
      assert.strictEqual(result.dependency_errors.length, 1);
      assert.strictEqual(result.dependency_errors[0].action, "add");
      assert.strictEqual(result.dependency_errors[0].blocking_merge_request, FAILING_BLOCKING_ID);
      assert.match(result.dependency_errors[0].error, /409/);
      assert.strictEqual(calls().filter(c => c === `POST ${mrPath}/blocks`).length, 2);
    });

    test("update_merge_request with only dependency changes skips the PUT", async () => {
      const result = await callTool(
        "update_merge_request",
        {
          project_id: TEST_PROJECT_ID,
          merge_request_iid: TEST_MR_IID,
          add_blocking_merge_requests: [9008],
          remove_blocking_merge_requests: [{ project_id: OTHER_PROJECT_ID, merge_request_iid: 7 }],
        },
        paramsEnv()
      );

      assert.strictEqual(result.dependency_errors, undefined);
      assert.deepStrictEqual(calls(), [
        `GET ${mrPath}`,
        `GET ${mrPath}/blocks`,
        `GET /projects/${OTHER_PROJECT_ID}/merge_requests/7`,
        `DELETE ${mrPath}/blocks/${BLOCK_ID}`,
        `POST ${mrPath}/blocks`,
      ]);
    });

    test("update_merge_request reports a blocking MR it cannot remove", async () => {
      const result = await callTool(
        "update_merge_request",
        {
          project_id: TEST_PROJECT_ID,
          merge_request_iid: TEST_MR_IID,
          title: "Renamed",
          remove_blocking_merge_requests: [9008],
        },
        paramsEnv()
      );

      assert.deepStrictEqual(requests[0], {
        method: "PUT",
        path: mrPath,
        body: { title: "Renamed" },
      });
      assert.strictEqual(result.dependency_errors.length, 1);
      assert.match(result.dependency_errors[0].error, /No dependency on merge request id 9008/);
      assert.strictEqual(calls().includes(`DELETE ${mrPath}/blocks/${BLOCK_ID}`), false);
    });

    test("update_merge_request rejects remove_blocking_merge_requests in modify mode", async () => {
      const [response] = await rpc(
        [
          {
            method: "tools/call",
            params: {
              name: "update_merge_request",
              arguments: {
                project_id: TEST_PROJECT_ID,
                merge_request_iid: TEST_MR_IID,
                title: "Renamed",
                remove_blocking_merge_requests: [9007],
              },
            },
          },
        ],
        { ...paramsEnv(), GITLAB_PERMISSION_MODE: "modify" }
      );

      const text = response.error?.message ?? response.result?.content?.[0]?.text ?? "";
      assert.match(text, /does not allow remove_blocking_merge_requests in modify mode/);
      assert.strictEqual(requests.length, 0);
    });

    test("get_merge_request with include_dependencies adds both directions", async () => {
      const result = await callTool(
        "get_merge_request",
        { project_id: TEST_PROJECT_ID, merge_request_iid: TEST_MR_IID, include_dependencies: true },
        paramsEnv()
      );

      assert.deepStrictEqual(result.blocked_by, [BLOCK]);
      assert.deepStrictEqual(result.blocking, []);
    });
  });

  describe("with GITLAB_TOOLSETS set", () => {
    test("lists the dedicated tools and the core MR tools without the params", async () => {
      const [list] = await rpc([{ method: "tools/list", params: {} }], toolsEnv());

      for (const name of DEDICATED_TOOLS) {
        assert.ok(toolProperties(list, name), `${name} should be listed`);
      }
      assert.strictEqual(
        toolProperties(list, "create_merge_request")?.includes("blocking_merge_requests"),
        false
      );
      assert.strictEqual(
        toolProperties(list, "update_merge_request")?.includes("add_blocking_merge_requests"),
        false
      );
      assert.strictEqual(
        toolProperties(list, "get_merge_request")?.includes("include_dependencies"),
        false
      );
    });

    test("create_merge_request ignores blocking_merge_requests", async () => {
      await callTool(
        "create_merge_request",
        {
          project_id: TEST_PROJECT_ID,
          title: "Feature",
          source_branch: "feature",
          target_branch: "main",
          blocking_merge_requests: [9007],
        },
        toolsEnv()
      );

      assert.deepStrictEqual(calls(), [`POST /projects/${TEST_PROJECT_ID}/merge_requests`]);
    });

    test("list_merge_request_dependencies reads blocks by default and blockees for blocking", async () => {
      const blockedBy = await callTool(
        "list_merge_request_dependencies",
        { project_id: TEST_PROJECT_ID, merge_request_iid: TEST_MR_IID },
        toolsEnv()
      );
      const blocking = await callTool(
        "list_merge_request_dependencies",
        { project_id: TEST_PROJECT_ID, merge_request_iid: TEST_MR_IID, direction: "blocking" },
        toolsEnv()
      );

      assert.deepStrictEqual(blockedBy, [BLOCK]);
      assert.deepStrictEqual(blocking, []);
      assert.deepStrictEqual(calls(), [`GET ${mrPath}/blocks`, `GET ${mrPath}/blockees`]);
    });

    test("create_merge_request_dependency sends a global id as is", async () => {
      const result = await callTool(
        "create_merge_request_dependency",
        {
          project_id: TEST_PROJECT_ID,
          merge_request_iid: TEST_MR_IID,
          blocking_merge_request: "9007",
        },
        toolsEnv()
      );

      assert.strictEqual(result.id, BLOCK.id);
      assert.deepStrictEqual(calls(), [`POST ${mrPath}/blocks`]);
      assert.deepStrictEqual(requests[0].body, { blocking_merge_request_id: 9007 });
    });

    test("create_merge_request_dependency resolves an iid in another project", async () => {
      await callTool(
        "create_merge_request_dependency",
        {
          project_id: TEST_PROJECT_ID,
          merge_request_iid: TEST_MR_IID,
          blocking_merge_request: { project_id: OTHER_PROJECT_ID, merge_request_iid: 7 },
        },
        toolsEnv()
      );

      assert.deepStrictEqual(calls(), [
        `GET /projects/${OTHER_PROJECT_ID}/merge_requests/7`,
        `POST ${mrPath}/blocks`,
      ]);
      assert.deepStrictEqual(requests[1].body, { blocking_merge_request_id: 9007 });
    });

    test("create_merge_request_dependency rejects a missing blocking MR", async () => {
      await expectToolError(
        callTool(
          "create_merge_request_dependency",
          { project_id: TEST_PROJECT_ID, merge_request_iid: TEST_MR_IID },
          toolsEnv()
        ),
        /blocking_merge_request/
      );
      assert.strictEqual(requests.length, 0);
    });

    test("delete_merge_request_dependency deletes the block", async () => {
      const result = await callTool(
        "delete_merge_request_dependency",
        { project_id: TEST_PROJECT_ID, merge_request_iid: TEST_MR_IID, block_id: BLOCK_ID },
        toolsEnv()
      );

      assert.strictEqual(result.status, "success");
      assert.deepStrictEqual(calls(), [`DELETE ${mrPath}/blocks/${BLOCK_ID}`]);
    });
  });
});
