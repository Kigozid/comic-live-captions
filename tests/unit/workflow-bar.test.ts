import { describe, expect, it } from 'vitest';
import {
  buildWorkflowSteps,
  type WorkflowStepId,
} from '../../apps/web/src/workflow-steps.js';

describe('buildWorkflowSteps', () => {
  it('lists the major draft-first workflow in order', () => {
    const steps = buildWorkflowSteps({
      hasPage: false,
      hasAudio: false,
      hasCleaned: false,
      hasBoxes: false,
    });
    expect(steps.map((s: { id: WorkflowStepId }) => s.id)).toEqual([
      'import',
      'audio',
      'clean',
      'boxes',
      'draft',
    ]);
    expect(steps.every((s: { done: boolean }) => !s.done)).toBe(true);
  });

  it('marks completed stages and cleaning/producing busy flags', () => {
    const steps = buildWorkflowSteps({
      hasPage: true,
      hasAudio: true,
      hasCleaned: true,
      hasBoxes: true,
      cleaning: false,
      producing: true,
    });
    expect(steps.find((s: { id: WorkflowStepId }) => s.id === 'import')?.done).toBe(true);
    expect(steps.find((s: { id: WorkflowStepId }) => s.id === 'audio')?.done).toBe(true);
    expect(steps.find((s: { id: WorkflowStepId }) => s.id === 'clean')?.done).toBe(true);
    expect(steps.find((s: { id: WorkflowStepId }) => s.id === 'boxes')?.done).toBe(true);
    expect(steps.find((s: { id: WorkflowStepId }) => s.id === 'draft')?.busy).toBe(true);
    expect(steps.find((s: { id: WorkflowStepId }) => s.id === 'draft')?.done).toBe(false);
  });
});


describe('buildWorkflowSteps', () => {
  it('lists the major draft-first workflow in order', () => {
    const steps = buildWorkflowSteps({
      hasPage: false,
      hasAudio: false,
      hasCleaned: false,
      hasBoxes: false,
    });
    expect(steps.map((s) => s.id as WorkflowStepId)).toEqual([
      'import',
      'audio',
      'clean',
      'boxes',
      'draft',
    ]);
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it('marks completed stages and cleaning/producing busy flags', () => {
    const steps = buildWorkflowSteps({
      hasPage: true,
      hasAudio: true,
      hasCleaned: true,
      hasBoxes: true,
      cleaning: false,
      producing: true,
    });
    expect(steps.find((s) => s.id === 'import')?.done).toBe(true);
    expect(steps.find((s) => s.id === 'audio')?.done).toBe(true);
    expect(steps.find((s) => s.id === 'clean')?.done).toBe(true);
    expect(steps.find((s) => s.id === 'boxes')?.done).toBe(true);
    expect(steps.find((s) => s.id === 'draft')?.busy).toBe(true);
    expect(steps.find((s) => s.id === 'draft')?.done).toBe(false);
  });
});
