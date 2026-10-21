import { z } from 'zod';
import { annotationSchema, documentSchema, idSchema, reviewSchema } from './model';
import type { Annotation, AnnotationDocument, ReviewState } from './model';

export const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('put'), annotation: annotationSchema, index: z.number().int().nonnegative().max(100_000).optional() }),
  z.strictObject({ type: z.literal('remove'), id: idSchema }),
  z.strictObject({ type: z.literal('review'), review: reviewSchema }),
]);
export type Command = z.infer<typeof commandSchema>;
interface Change { forward: Command[]; inverse: Command[] }

function mutate(doc: AnnotationDocument, command: Command): { next: AnnotationDocument; inverse: Command } {
  let annotations: Annotation[] = doc.annotations, review: ReviewState = doc.review;
  let inverse: Command;
  switch (command.type) {
    case 'put': {
      const old = annotations.find(a => a.id === command.annotation.id);
      inverse = old ? { type: 'put', annotation: old } : { type: 'remove', id: command.annotation.id };
      if (command.index !== undefined && (old || command.index > annotations.length)) throw new Error('Invalid annotation insertion index.');
      annotations = [...annotations];
      if (old) annotations[annotations.findIndex(a => a.id === old.id)] = command.annotation;
      else annotations.splice(command.index ?? annotations.length, 0, command.annotation);
      break;
    }
    case 'remove': {
      const old = annotations.find(a => a.id === command.id);
      if (!old) throw new Error('Cannot remove an unknown annotation.');
      inverse = { type: 'put', annotation: old, index: annotations.indexOf(old) };
      annotations = annotations.filter(a => a.id !== command.id);
      break;
    }
    case 'review':
      inverse = { type: 'review', review };
      review = command.review;
  }
  const next = documentSchema.parse({ ...doc, annotations, review, revision: doc.revision + 1 });
  return { next, inverse };
}

function applyCommands(document: AnnotationDocument, commands: readonly Command[], enforceLocks = false) {
  let next = document;
  const inverse: Command[] = [];
  for (const command of commands) {
    if (enforceLocks && (command.type === 'put' || command.type === 'remove')) {
      const id = command.type === 'put' ? command.annotation.id : command.id;
      const old = next.annotations.find(annotation => annotation.id === id);
      if (old?.locked) {
        const unlocked = command.type === 'put' && command.annotation.locked === false &&
          JSON.stringify({ ...command.annotation, locked: true }) === JSON.stringify({ ...old, locked: true });
        if (!unlocked) throw new Error('Unlock this annotation before changing or deleting it.');
      }
    }
    const result = mutate(next, command);
    next = result.next;
    inverse.unshift(result.inverse);
  }
  return {
    next: documentSchema.parse({ ...next, revision: document.revision + 1 }),
    inverse,
  };
}

// One history owns one image; entries retain changed annotations, not dataset snapshots.
export class ImageHistory {
  private doc: AnnotationDocument;
  private undoEntries: Change[] = [];
  private redoEntries: Change[] = [];

  constructor(document: unknown, private readonly limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid history limit.');
    this.doc = documentSchema.parse(document);
  }
  snapshot(): AnnotationDocument { return structuredClone(this.doc); }
  get canUndo(): boolean { return this.undoEntries.length > 0; }
  get canRedo(): boolean { return this.redoEntries.length > 0; }
  // Adopt a newer document from another participant while keeping this user's
  // own undo/redo entries; replays that no longer apply fail validation.
  rebase(document: unknown): void {
    const next = documentSchema.parse(document);
    if (next.image.id !== this.doc.image.id || next.revision < this.doc.revision) throw new Error('Cannot rebase onto an older or different image.');
    this.doc = next;
  }

  private check(revision: number): void {
    if (revision !== this.doc.revision) throw new Error('Stale image revision.');
  }
  execute(input: unknown, expectedRevision: number): AnnotationDocument {
    return this.executeBatch([input], expectedRevision);
  }
  executeBatch(inputs: readonly unknown[], expectedRevision: number): AnnotationDocument {
    this.check(expectedRevision);
    const forward = z.array(commandSchema).min(1).max(1000).parse(inputs);
    const { next, inverse } = applyCommands(this.doc, forward, true);
    this.doc = next;
    this.undoEntries.push({ forward, inverse });
    if (this.undoEntries.length > this.limit) this.undoEntries.shift();
    this.redoEntries = [];
    return this.snapshot();
  }
  undo(expectedRevision: number): AnnotationDocument {
    this.check(expectedRevision);
    const change = this.undoEntries.at(-1);
    if (!change) throw new Error('No edit to undo.');
    this.doc = applyCommands(this.doc, change.inverse).next;
    this.undoEntries.pop();
    this.redoEntries.push(change);
    return this.snapshot();
  }
  redo(expectedRevision: number): AnnotationDocument {
    this.check(expectedRevision);
    const change = this.redoEntries.at(-1);
    if (!change) throw new Error('No edit to redo.');
    this.doc = applyCommands(this.doc, change.forward).next;
    this.redoEntries.pop();
    this.undoEntries.push(change);
    return this.snapshot();
  }
}
