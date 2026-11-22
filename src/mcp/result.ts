/**
 * The envelope every custom MCP tool answers in.
 *
 * MCP tool results are text — a client renders what it gets. So the convention here
 * is a JSON document with an explicit `ok`, which an LLM can branch on without
 * parsing English: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
 *
 * Two rules, both about not leaking:
 *
 *  - **A message is written here, not copied from a thrown error.** Payload's access
 *    errors, database errors and validation errors carry text that names the
 *    collection, the field, sometimes a value. A machine credential on the far end of
 *    a public endpoint gets a code and a sentence a developer would write.
 *  - **Nothing throws out of a tool.** An uncaught error inside a handler surfaces as
 *    a transport-level failure and the client learns nothing about what went wrong;
 *    a structured refusal at least tells it not to retry.
 */

export type McpToolResult = {
  content: Array<{ text: string; type: 'text' }>
}

const TRUNCATE = 2000

/** A successful answer. `data` is serialized once, here. */
export const okResult = (data: unknown): McpToolResult => ({
  content: [{ text: JSON.stringify({ ok: true, data }, null, 2).slice(0, 200_000), type: 'text' }],
})

/**
 * A refusal. `code` is stable and documented (`docs/mcp.md`); `message` is for the
 * person reading the transcript, not for the caller's logs.
 */
export const errorResult = (
  code:
    | 'invalid_input'
    | 'not_permitted'
    | 'not_found'
    | 'tool_failed'
    | 'unsupported_collection',
  message: string,
): McpToolResult => ({
  content: [{ text: JSON.stringify({ ok: false, error: { code, message } }, null, 2), type: 'text' }],
})

/**
 * The safe string of an unexpected error: a bounded first line, with nothing that
 * looks like a credential or a stack frame. Used only in the MCP server's own log —
 * never in a tool response.
 */
export const safeErrorDetail = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.split('\n')[0]?.slice(0, TRUNCATE) ?? 'unknown error'
}
