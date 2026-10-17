export interface Capability { name: string; available: boolean; detail: string; requiredFor: 'vault' | 'media' | 'later' }
export function detectCapabilities(): Capability[] {
  return [
    { name: 'Secure context', available: isSecureContext, detail: 'HTTPS or a trustworthy localhost origin.', requiredFor: 'vault' },
    { name: 'Web Crypto', available: !!globalThis.crypto?.subtle, detail: 'PBKDF2, HKDF, and AES-256-GCM.', requiredFor: 'vault' },
    { name: 'OPFS', available: typeof navigator.storage?.getDirectory === 'function', detail: 'Actual persistence is verified when opening the proof vault.', requiredFor: 'vault' },
    { name: 'Web Locks', available: !!navigator.locks, detail: 'One worker/tab owns the proof database.', requiredFor: 'vault' },
    { name: 'Module workers', available: typeof Worker !== 'undefined', detail: 'Storage and media work stay off the UI thread.', requiredFor: 'vault' },
    { name: 'WebAssembly', available: typeof WebAssembly !== 'undefined', detail: 'Self-hosted official SQLite WASM.', requiredFor: 'vault' },
    { name: 'OffscreenCanvas', available: typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function', detail: 'Worker-based image decode and lossless PNG output.', requiredFor: 'media' },
    { name: 'Folder picker', available: 'showDirectoryPicker' in window, detail: 'Phase 2; explicit file selection remains an alternative.', requiredFor: 'later' },
  ];
}
