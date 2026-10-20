export type WorkflowStepId =
  | 'import'
  | 'audio'
  | 'clean'
  | 'boxes'
  | 'draft';

export interface WorkflowStepStatus {
  readonly id: WorkflowStepId;
  readonly label: string;
  readonly hint: string;
  readonly done: boolean;
  readonly busy?: boolean;
  readonly disabled?: boolean;
}

/** Pure helper: draft-first step list for the always-visible workflow strip. */
export function buildWorkflowSteps(input: {
  readonly hasPage: boolean;
  readonly hasAudio: boolean;
  readonly hasCleaned: boolean;
  readonly hasBoxes: boolean;
  readonly cleaning?: boolean;
  readonly producing?: boolean;
}): WorkflowStepStatus[] {
  return [
    {
      id: 'import',
      label: 'Import page',
      hint: 'Add the original comic page (cleaned optional)',
      done: input.hasPage,
    },
    {
      id: 'audio',
      label: 'Audio',
      hint: 'Import narration audio',
      done: input.hasAudio,
    },
    {
      id: 'clean',
      label: 'Clean',
      hint: 'Erase original lettering from speech balloons',
      done: input.hasCleaned,
      ...(input.cleaning ? { busy: true } : {}),
    },
    {
      id: 'boxes',
      label: 'Boxes',
      hint: 'Draw caption containers on the cleaned page',
      done: input.hasBoxes,
    },
    {
      id: 'draft',
      label: 'Draft',
      hint: 'Produce the full draft video',
      done: false,
      ...(input.producing ? { busy: true } : {}),
    },
  ];
}
