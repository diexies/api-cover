// Single source of truth for the JSONLogic hint popover. Keep aligned with:
//   - src/APICover.Abstractions/Models/RunContext.cs (default vars)
//   - src/APICover/Engine/ScenarioEngine.cs (streaming + group vars)
//   - src/APICover.Abstractions/Models/ExecutionGroup.cs (NodeMutation mutation context)
//   - ui/src/inspector/jsonlogic-eval.ts (supported operators in the UI preview evaluator)

export type JsonLogicContext = 'default' | 'streaming' | 'group';

export interface VarSpec {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  doc: string;
}

export interface OpSpec {
  op: string;
  args: string;
  example: string;
  doc: string;
}

const DEFAULT_VARS: VarSpec[] = [
  { path: 'input.*',
    type: 'object',
    doc: 'Run input payload supplied at start.' },
  { path: 'env.*',
    type: 'object',
    doc: 'Environment / configuration values exposed to rules.' },
  { path: 'nodes.<nodeId>.request.method',
    type: 'string',
    doc: 'HTTP method that was sent for the given node.' },
  { path: 'nodes.<nodeId>.request.path',
    type: 'string',
    doc: 'Resolved request path (after path-parameter substitution).' },
  { path: 'nodes.<nodeId>.request.headers',
    type: 'object',
    doc: 'Request headers as a flat map.' },
  { path: 'nodes.<nodeId>.request.body',
    type: 'object',
    doc: 'Request body — parsed JSON when applicable.' },
  { path: 'nodes.<nodeId>.response.status',
    type: 'number',
    doc: 'HTTP status code returned for the node.' },
  { path: 'nodes.<nodeId>.response.headers',
    type: 'object',
    doc: 'Response headers as a flat map.' },
  { path: 'nodes.<nodeId>.response.body',
    type: 'object',
    doc: 'Response body — parsed JSON when applicable.' },
];

const STREAMING_VARS: VarSpec[] = [
  { path: 'message',
    type: 'object',
    doc: 'Current streamed chunk (SSE event payload or NDJSON line).' },
  { path: 'index',
    type: 'number',
    doc: '0-based index of the current chunk within the stream.' },
  { path: 'elapsed',
    type: 'number',
    doc: 'Milliseconds since the stream opened.' },
];

const GROUP_VARS: VarSpec[] = [
  { path: 'iteration',
    type: 'number',
    doc: 'Current 0-based step index within the group repeat loop.' },
  { path: 'total',
    type: 'number',
    doc: 'Total number of iterations configured for this group.' },
  { path: 'random',
    type: 'number',
    doc: 'Fresh random number in [0, 1) per iteration.' },
  { path: 'previous.<field>',
    type: 'object',
    doc: 'Response of the previous iteration of the same node (e.g. previous.body.id).' },
  { path: 'groups.<groupId>.iteration',
    type: 'number',
    doc: 'Iteration index of another group when nodes belong to multiple groups.' },
  { path: 'groups.<groupId>.total',
    type: 'number',
    doc: 'Total iterations of another group.' },
];

export const JSONLOGIC_VARS: Record<JsonLogicContext, VarSpec[]> = {
  default: DEFAULT_VARS,
  streaming: [...DEFAULT_VARS, ...STREAMING_VARS],
  group: [...DEFAULT_VARS, ...GROUP_VARS],
};

export const JSONLOGIC_OPS: OpSpec[] = [
  { op: 'var',
    args: '"path"',
    example: '{"var": "nodes.login.response.body.id"}',
    doc: 'Read a value from the context by dot-path.' },
  { op: 'if',
    args: '[cond, then, ...elseif/then, else]',
    example: '{"if": [{">":[{"var":"response.status"},299]}, "error", "ok"]}',
    doc: 'Ternary chain — pairs of (condition, then), final fallback.' },
  { op: '==',
    args: '[a, b]',
    example: '{"==": [{"var":"response.status"}, 200]}',
    doc: 'Equality (loose comparison).' },
  { op: '!=',
    args: '[a, b]',
    example: '{"!=": [{"var":"response.status"}, 200]}',
    doc: 'Inequality.' },
  { op: '>',  args: '[a, b]', example: '{">":  [{"var":"x"}, 0]}', doc: 'Greater than.' },
  { op: '>=', args: '[a, b]', example: '{">=": [{"var":"x"}, 0]}', doc: 'Greater than or equal.' },
  { op: '<',  args: '[a, b]', example: '{"<":  [{"var":"x"}, 100]}', doc: 'Less than.' },
  { op: '<=', args: '[a, b]', example: '{"<=": [{"var":"x"}, 100]}', doc: 'Less than or equal.' },
  { op: '+', args: '[a, b, ...]', example: '{"+": [{"var":"iteration"}, 1]}', doc: 'Sum of arguments.' },
  { op: '-', args: '[a, b]', example: '{"-": [{"var":"total"}, {"var":"iteration"}]}', doc: 'Subtraction (single-arg negates).' },
  { op: '*', args: '[a, b, ...]', example: '{"*": [{"var":"x"}, 2]}', doc: 'Product of arguments.' },
  { op: '/', args: '[a, b]', example: '{"/": [{"var":"total"}, 2]}', doc: 'Division.' },
  { op: 'cat',
    args: '[s1, s2, ...]',
    example: '{"cat": ["user-", {"var":"iteration"}]}',
    doc: 'String concatenation.' },
  { op: 'regex_match',
    args: '[pattern, text]',
    example: '{"regex_match": ["^foo", {"var":"response.body.name"}]}',
    doc: 'Tests if pattern matches text (returns boolean).' },
];
