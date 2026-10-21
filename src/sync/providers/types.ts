declare const ciphertextBrand: unique symbol;

/** Caller attestation only: encryption/authentication belongs upstream, not in a provider. */
export type Ciphertext = Uint8Array<ArrayBuffer> & { readonly [ciphertextBrand]: true };
export function ciphertext(bytes: Uint8Array<ArrayBuffer>): Ciphertext {
  if (!(bytes instanceof Uint8Array)) throw new ProviderError('invalid-input');
  return bytes as Ciphertext;
}

export type ErrorCode = 'invalid-input' | 'unsupported-condition' | 'credential-expired' |
  'permission-denied' | 'conflict' | 'not-found' | 'too-large' | 'invalid-response' | 'network' | 'http';
export class ProviderError extends Error {
  constructor(readonly code: ErrorCode, readonly status?: number) {
    // Never include response bodies, URLs, tokens, object contents or caller errors.
    super(`Encrypted object provider: ${code}${status === undefined ? '' : ` (${status})`}`);
    this.name = 'ProviderError';
  }
}

export interface AccessToken {
  accessToken: string;
  /** Unix epoch milliseconds. No refresh token or OAuth client secret is accepted. */
  expiresAt: number;
}
export interface Credentials {
  token: AccessToken;
  refresh?: (signal: AbortSignal) => Promise<AccessToken>;
}
export interface ProviderOptions {
  credentials: Credentials;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
export interface ObjectEntry {
  /** HF: opaque key; Drive: provider file ID (names are not unique). */
  id: string;
  key: string;
  size: number;
}
export interface ObjectPage { objects: ObjectEntry[]; cursor?: string }
export type WriteCondition = { kind: 'unconditional' } | { kind: 'revision'; revision: string } | { kind: 'create-only' };
export interface PutOptions {
  condition: WriteCondition;
  /** Drive file ID to replace; absent means create a new, potentially duplicate-named file. */
  objectId?: string;
  signal?: AbortSignal;
}
export interface ProviderCapabilities {
  conditionalWrites: 'repository-parent-commit' | 'none';
  createOnly: false;
  atomicPublication: false;
  maxObjectBytes: number;
  uploadStreaming: false;
  downloadStreaming: 'bounded-buffer';
  automaticRetries: false;
}
export interface EncryptedObjectProvider {
  readonly capabilities: Readonly<ProviderCapabilities>;
  put(key: string, bytes: Ciphertext, options: PutOptions): Promise<{ id: string; revision?: string }>;
  get(id: string, signal?: AbortSignal): Promise<Ciphertext | null>;
  list(options?: { cursor?: string; signal?: AbortSignal }): Promise<ObjectPage>;
}
