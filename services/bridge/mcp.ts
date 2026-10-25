import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Bridge, BridgeError } from './bridge.ts';
import { annotateInput, getAnnotationsInput, listImagesInput, pairCode, viewImagesInput, viewImagesResult } from './protocol.ts';
import type { JobKind } from './protocol.ts';

const instructions = `Annotator: label images that the user has open in the private annotation website.
Workflow: (1) The user clicks Connect in the website and gives you a 6-digit code; call bridge_pair with it.
(2) list_images to get image IDs, sizes and existing class names. (3) view_images (up to 6 at a time) to see pixels;
the user may need to approve in the website. (4) annotate to add/update/remove boxes, polygons and whole-image labels
by class name; unknown class names are created. Coordinates are original-image pixels [x, y, width, height] with the
origin at the top-left, or set units:"normalized" for 0–1 fractions. Work in batches of several images per annotate call.
Edits are either applied immediately (undoable) or wait for the user's review, depending on their website setting.`;

const messages: Record<BridgeError['code'], string> = {
  denied: 'Not permitted.', invalid: 'Invalid request.', stale: 'The image changed; re-read it and retry.',
  limited: 'Too many requests; slow down.', offline: 'The website is offline.', timeout: 'Timed out.',
  declined: 'The user declined this request in the website.', failed: 'The website could not complete the request.',
};

export function createMcpServer(bridge: Bridge) {
  const server = new McpServer({ name: 'annotator', version: '0.2.0' }, { instructions });
  const failure = (error: unknown) => {
    const code = error instanceof BridgeError ? error.code : 'failed';
    const detail = error instanceof BridgeError && error.detail ? ` ${error.detail}` : '';
    return { isError: true, content: [{ type: 'text' as const, text: `${code}: ${messages[code]}${detail}` }] };
  };
  const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const local = (action: () => unknown) => {
    try { bridge.limit('tool', 300); return text(action()); } catch (error) { return failure(error); }
  };
  const remote = async (kind: JobKind, args: unknown) => {
    try { bridge.limit('tool', 300); return text(await bridge.call(kind, args)); } catch (error) { return failure(error); }
  };
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  server.registerTool('bridge_pair', {
    description: 'Connect to the annotation website using the 6-digit code the user sees after clicking Connect.',
    inputSchema: pairCode, annotations: { destructiveHint: false, openWorldHint: false },
  }, args => local(() => bridge.confirmPair(args)));
  server.registerTool('bridge_status', {
    description: 'Connection state, granted permissions and whether the website tab is responding.',
    inputSchema: z.strictObject({}), annotations: readOnly,
  }, () => local(() => bridge.status()));
  server.registerTool('bridge_revoke', {
    description: 'Disconnect from the website and discard all pending requests.',
    inputSchema: z.strictObject({}), annotations: { destructiveHint: false, openWorldHint: false },
  }, () => local(() => { bridge.clear(); return { cleared: true }; }));
  server.registerTool('list_images', {
    description: 'List dataset images (opaque id, width, height, review state, annotation count) and the class names in use. No filenames. Paginate with offset/limit (max 200); filter by review state, e.g. "unannotated".',
    inputSchema: listImagesInput, annotations: readOnly,
  }, args => remote('list', args));
  server.registerTool('get_annotations', {
    description: 'Read the current annotations of up to 25 images: class label, kind, box [x,y,w,h] or polygon/line points in original-image pixels, plus each image revision.',
    inputSchema: getAnnotationsInput, annotations: readOnly,
  }, args => remote('annotations', args));
  server.registerTool('view_images', {
    description: 'See up to 6 images (JPEG, longest side ≤ maxSize, default 1024). The user may need to approve. Images can be downscaled; always express annotate coordinates in ORIGINAL pixels (scale by width/sentWidth) or use units:"normalized".',
    inputSchema: viewImagesInput, annotations: readOnly,
  }, async args => {
    try {
      bridge.limit('tool', 300);
      const result = viewImagesResult.parse(await bridge.call('images', args));
      return { content: result.images.flatMap(image => [
        { type: 'text' as const, text: JSON.stringify({ id: image.id, width: image.width, height: image.height,
          sentWidth: image.sentWidth, sentHeight: image.sentHeight, scaleToOriginal: image.width / image.sentWidth }) },
        { type: 'image' as const, data: image.data, mimeType: image.mimeType },
      ]) };
    } catch (error) { return failure(error); }
  });
  server.registerTool('annotate', {
    description: 'Add, update or remove annotations on up to 50 images in one call. add: [{label, box:[x,y,w,h]} | {label, polygon:[[x,y],...]} | {label} for a whole-image label]. update: [{id, label?, box?, polygon?}]. remove: [annotationId]. review: "annotated"/"reviewed"/... Labels are class names; missing classes are created. Returns applied/rejected per the user\'s review.',
    inputSchema: annotateInput, annotations: { destructiveHint: true, openWorldHint: false },
  }, args => remote('annotate', args));
  return server;
}
