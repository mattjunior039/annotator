import { documentSchema } from '../domain/model';
import type { AnnotationDocument } from '../domain/model';
import { ImageHistory } from '../domain/history';
import type { Command } from '../domain/history';

const MAX_COMMANDS = 64;

// Express a guest's local edit as annotation-level commands so the host can
// replay it onto the latest document instead of overwriting concurrent edits.
export function diffDocuments(base: AnnotationDocument, next: AnnotationDocument): Command[] {
  if (base.image.id !== next.image.id || JSON.stringify(base.image) !== JSON.stringify(next.image) ||
      JSON.stringify(base.classes) !== JSON.stringify(next.classes) ||
      JSON.stringify(base.skeletons) !== JSON.stringify(next.skeletons)) {
    throw new Error('Only the host can change classes, skeletons, or image details during a live session.');
  }
  const before = new Map(base.annotations.map(item => [item.id, item]));
  const after = new Set(next.annotations.map(item => item.id));
  const commands: Command[] = [];
  for (const annotation of next.annotations) {
    const old = before.get(annotation.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(annotation)) commands.push({ type: 'put', annotation });
  }
  for (const annotation of base.annotations) if (!after.has(annotation.id)) commands.push({ type: 'remove', id: annotation.id });
  if (base.review !== next.review) commands.push({ type: 'review', review: next.review });
  if (commands.length > MAX_COMMANDS) throw new Error('This change is too large to share in one live edit.');
  return commands;
}

// Host-side replay. Mask pixels stay host-only because their tiles live in the
// host vault (allowMasks is set only for the host's own edits); lock rules and
// document validation come from ImageHistory.
export function applyGuestCommands(
  latest: AnnotationDocument, commands: readonly Command[], allowMasks = false,
): AnnotationDocument {
  if (commands.length === 0 || commands.length > MAX_COMMANDS) throw new Error('Invalid live edit.');
  const history = new ImageHistory(latest);
  for (const command of commands) {
    const current = history.snapshot();
    const masked = new Error('Mask painting is host-only during live sessions.');
    if (command.type === 'put' && command.annotation.kind === 'mask' && !allowMasks) throw masked;
    if (command.type === 'remove') {
      const existing = current.annotations.find(item => item.id === command.id);
      if (!existing) continue; // Already removed by another participant.
      if (existing.kind === 'mask' && !allowMasks) throw masked;
    }
    if (command.type === 'put' && !allowMasks) {
      const existing = current.annotations.find(item => item.id === command.annotation.id);
      if (existing?.kind === 'mask') throw masked;
    }
    history.execute(command, current.revision);
  }
  const merged = history.snapshot();
  if (merged.revision === latest.revision) return latest;
  return documentSchema.parse({ ...merged, revision: latest.revision + 1 });
}
