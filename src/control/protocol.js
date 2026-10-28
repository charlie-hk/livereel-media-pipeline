/**
 * Control protocol.
 *
 * One JSON object per WebSocket message. Requests carry an `id` that the reply echoes, so a
 * client can have several commands in flight without inferring which reply belongs to which
 * request from ordering alone.
 *
 *   request   { id, type, ...params }
 *   reply     { id, ok: true, result }  |  { id, ok: false, error: { code, message } }
 *   event     { type: "event", event, data, ts }
 *
 * Events are not replies and never carry an `id`.
 */

export const PROTOCOL_VERSION = 1;

export const ErrorCode = {
  BAD_REQUEST: 'bad_request',
  UNAUTHORIZED: 'unauthorized',
  UNKNOWN_COMMAND: 'unknown_command',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  UNAVAILABLE: 'unavailable',
  INTERNAL: 'internal',
};

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Parse and shape-check an incoming frame.
 *
 * Anything arriving on a socket is untrusted, so this rejects rather than coerces: a command
 * with a missing id or a non-string type is an error the client should see, not something to
 * paper over with a default.
 */
export function parseRequest(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    throw new ProtocolError(ErrorCode.BAD_REQUEST, 'message is not valid JSON');
  }

  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new ProtocolError(ErrorCode.BAD_REQUEST, 'message must be a JSON object');
  }
  if (typeof message.type !== 'string' || message.type.length === 0) {
    throw new ProtocolError(ErrorCode.BAD_REQUEST, 'message needs a "type" string');
  }
  if (message.id !== undefined && typeof message.id !== 'string' && typeof message.id !== 'number') {
    throw new ProtocolError(ErrorCode.BAD_REQUEST, '"id" must be a string or number');
  }

  return message;
}

export function reply(id, result) {
  return JSON.stringify({ id, ok: true, result });
}

export function replyError(id, code, message) {
  return JSON.stringify({ id, ok: false, error: { code, message } });
}

export function event(name, data) {
  return JSON.stringify({ type: 'event', event: name, data, ts: Date.now() });
}

/** Require a field of a given type, with the error naming the field rather than the shape. */
export function requireField(message, field, type = 'string') {
  const value = message[field];
  if (value === undefined || value === null) {
    throw new ProtocolError(ErrorCode.BAD_REQUEST, `"${field}" is required`);
  }
  if (type === 'array' ? !Array.isArray(value) : typeof value !== type) {
    throw new ProtocolError(ErrorCode.BAD_REQUEST, `"${field}" must be ${type}`);
  }
  return value;
}
